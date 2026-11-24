import { describe, expect, it } from "vitest";
import { indentUnit } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
  type PythonBase,
  classBases,
  classMembers,
  enclosingClass,
  forwardedArgs,
  insertMembers,
  linearize,
  memberStubs,
  overrideChoices,
  overrideText,
  signatureNames,
} from "./members";

const src = `from abc import ABC, abstractmethod


class Shape(ABC):
    @property
    @abstractmethod
    def name(self) -> str: ...

    @abstractmethod
    def area(
        self, scale: float = 1.0
    ) -> float:
        """Area."""

    def describe(self) -> str:
        return self.name


class Square(Shape):
    def __init__(self, side: float):
        self.side = side
`.split("\n");

describe("python members", () => {
  it("finds the class enclosing a line", () => {
    expect(enclosingClass(src, 4)).toBe(4);
    expect(enclosingClass(src, 13)).toBe(4);
    expect(enclosingClass(src, 21)).toBe(19);
    expect(enclosingClass(src, 1)).toBeNull();
  });

  it("lists methods with their decorators and signatures", () => {
    const members = classMembers(src, 4);
    expect(members.map((m) => [m.name, m.abstract])).toEqual([
      ["name", true],
      ["area", true],
      ["describe", false],
    ]);
    expect(members[0]!.lines).toEqual(["@property", "def name(self) -> str:"]);
    expect(members[1]!.lines).toEqual(["def area(", "    self, scale: float = 1.0", ") -> float:"]);
  });

  it("stops at a nested class without bases", () => {
    const nested = ["class Outer(Base):", "    class Inner:", "        x = 1", ""];
    expect(enclosingClass(nested, 3)).toBeNull();
  });

  it("keeps a body going through an unindented string", () => {
    const lines = [
      "class A(ABC):",
      "    @abc.abstractproperty",
      "    def doc(self):",
      '        return """',
      "text",
      '"""',
      "    @abstractmethod",
      "    def run(self): ...",
      "x = 1",
    ];
    const members = classMembers(lines, 1);
    expect(members.map((m) => m.lines)).toEqual([["@property", "def doc(self):"], ["def run(self):"]]);
    expect(members.every((m) => m.abstract)).toBe(true);
  });

  it("writes stubs at the body's indentation", () => {
    const [name] = classMembers(src, 4);
    expect(memberStubs([name!], "    ", "    ")).toBe("    @property\n    def name(self) -> str:\n        pass");
  });
});

describe("python overrides", () => {
  it("passes the parameters on, keyword-only ones by keyword", () => {
    expect(forwardedArgs("def f(self, a, b: int = 2, /, c=None, *, d, **kw) -> None:")).toBe("a, b, c, d=d, **kw");
    expect(forwardedArgs("def g(cls, *args: Any, key: str = 'x') -> int:")).toBe("*args, key=key");
    expect(forwardedArgs("def h(x: dict[str, int] = {}):")).toBe("x");
  });

  it("calls the base through super(), without return for __init__ and None", () => {
    const [area, describe_] = classMembers(src, 4).slice(1);
    expect(overrideText(area!, "Shape", "    ", "    ")).toBe(
      "    def area(\n        self, scale: float = 1.0\n    ) -> float:\n        return super().area(scale)",
    );
    expect(overrideText(describe_!, "Shape", "    ", "    ")).toBe(
      "    def describe(self) -> str:\n        return super().describe()",
    );
    const init = classMembers(src, 19)[0]!;
    expect(overrideText(init, "Square", "", "  ")).toBe("def __init__(self, side: float):\n  super().__init__(side)");
    const [prop, stat, coro] = classMembers(
      [
        "class B:",
        "    @property",
        "    def name(self) -> str: ...",
        "    @staticmethod",
        "    def make(x) -> None: ...",
        "    async def fetch(self, url: str) -> bytes: ...",
        "    @overload",
        "    def get(self, k: int) -> int: ...",
      ],
      1,
    );
    expect(overrideText(prop!, "B", "", "    ")).toBe("@property\ndef name(self) -> str:\n    return super().name");
    expect(stat!.name).toBe("make");
    expect(overrideText(coro!, "B", "", "    ")).toBe(
      "async def fetch(self, url: str) -> bytes:\n    return await super().fetch(url)",
    );
    expect(classMembers(["class B:", "    @overload", "    def get(self) -> int: ..."], 1)[0]!.hidden).toBe(true);
  });

  it("finds a class without bases when asked", () => {
    expect(enclosingClass(["class A:", "    x = 1"], 2)).toBeNull();
    expect(enclosingClass(["class A:", "    x = 1"], 2, true)).toBe(1);
  });
});

describe("python override review cases", () => {
  it("splits parameters outside strings and lambdas", () => {
    expect(forwardedArgs('def f(self, names="a, b", x=1):')).toBe("names, x");
    expect(forwardedArgs('def f(self, close=")", later=2):')).toBe("close, later");
    expect(forwardedArgs('def f(self, open="(", y=0):')).toBe("open, y");
    expect(forwardedArgs("def f(self, key=lambda a, b: a, *, z):")).toBe("key, z=z");
  });

  it("cuts a one-line method at the colon closing its header", () => {
    const [go, repr] = classMembers(
      ["class B:", "    def go(self, x): return x + 1", '    def __repr__(self) -> str: return f"B({1}:{2})"'],
      1,
    );
    expect(go!.lines).toEqual(["def go(self, x):"]);
    expect(repr!.lines).toEqual(["def __repr__(self) -> str:"]);
    expect(overrideText(go!, "C", "", "    ")).toBe("def go(self, x):\n    return super().go(x)");
  });

  it("reads non-ASCII class, method and base names", () => {
    const src = ["class Größe(basis.Maß, Ünter):", "    def größe(self, wert: int) -> int: ..."];
    expect(enclosingClass(src, 2)).toBe(1);
    expect(classMembers(src, 1)[0]!.name).toBe("größe");
    expect(forwardedArgs("def größe(self, wert: int):")).toBe("wert");
  });

  it("calls a static method's base through the overriding class", () => {
    const [stat] = classMembers(["class B:", "    @staticmethod", "    def make(x) -> None: ..."], 1);
    expect(overrideText(stat!, "Child", "", "    ")).toBe(
      "@staticmethod\ndef make(x) -> None:\n    super(Child, Child).make(x)",
    );
  });

  it("lists the names an override's annotations, defaults and decorators use", () => {
    const [add] = classMembers(
      [
        "class B:",
        "    @functools.cache",
        "    def add(self, title: str, p: Priority = Priority.LOW, *, d: 'Date' = None) -> Task: ...",
      ],
      1,
    );
    expect(signatureNames(add!).sort()).toEqual([
      "Date",
      "LOW",
      "None",
      "Priority",
      "Task",
      "cache",
      "functools",
      "str",
    ]);
  });
});

describe("python overrides follow the MRO", () => {
  const base = (name: string, src: string[]): PythonBase => ({
    name,
    members: classMembers([`class ${name}:`, ...src], 1),
    lines: [],
    module: "",
  });

  it("linearizes bases as Python does (C3)", () => {
    const parents: Record<string, string[]> = { C: ["First", "Right"], First: ["Base"], Right: ["Base"], Base: [] };
    expect(linearize("C", (k) => parents[k] ?? [])).toEqual(["First", "Right", "Base"]);
    // `class D(Base, First)` puts Base before its own subclass: Python rejects it.
    expect(linearize("D", (k) => ({ ...parents, D: ["Base", "First"] })[k] ?? [])).toBeNull();
  });

  it("copies the definition first in the MRO, the one super() calls", () => {
    const first = base("First", ["    def label(self, text: str) -> str: ..."]);
    const right = base("Right", ["    def label(self, text: str, width: int) -> str: ...", "    def size(self): ..."]);
    const choices = overrideChoices([first, right], []);
    expect(choices.map((c) => [c.base.name, c.member.lines.join(" ")])).toEqual([
      ["First", "def label(self, text: str) -> str:"],
      ["Right", "def size(self):"],
    ]);
  });

  it("offers nothing for a name whose first definition is final or only overloads", () => {
    const first = base("First", [
      "    @final",
      "    def label(self): ...",
      "    @overload",
      "    def get(self) -> int: ...",
    ]);
    const right = base("Right", ["    def label(self, x): ...", "    def get(self): ..."]);
    expect(overrideChoices([first, right], [])).toEqual([]);
    const impl = base("Impl", ["    @overload", "    def get(self) -> int: ...", "    def get(self, *a): ..."]);
    expect(overrideChoices([impl], []).map((c) => c.member.lines.join(" "))).toEqual(["def get(self, *a):"]);
  });
});

describe("python class headers spanning lines", () => {
  const src = ["class C(", "    First,  # the main one", "    pkg.Right,", "):", "    def own(self): ...", "", ""];

  it("finds the class and its body below the header", () => {
    expect(enclosingClass(src, 5)).toBe(1);
    expect(enclosingClass(src, 6)).toBe(1);
    expect(enclosingClass(src, 2)).toBe(1);
    expect(classMembers(src, 1).map((m) => m.name)).toEqual(["own"]);
  });

  it("locates each base on its own line", () => {
    expect(classBases(src, 1)).toEqual([
      { name: "First", line: 1, col: 4 },
      { name: "pkg.Right", line: 2, col: 8 },
    ]);
  });
});

describe("python members inserted into a one-line class", () => {
  const insert = (doc: string) => {
    const view = new EditorView({ state: EditorState.create({ doc, extensions: indentUnit.of("    ") }) });
    insertMembers(view, doc.split("\n"), 1, (indent, unit) => `${indent}def go(self):\n${indent}${unit}pass`);
    return view.state.doc.toString();
  };

  it("replaces a `pass` body on the header line", () => {
    expect(insert("class Inline(Base): pass")).toBe("class Inline(Base):\n    def go(self):\n        pass");
  });

  it("moves a statement off the header line", () => {
    expect(insert("class Inline(Base): x = 1")).toBe(
      "class Inline(Base):\n    x = 1\n\n    def go(self):\n        pass",
    );
  });

  it("inserts below a header spanning lines", () => {
    expect(insert("class C(\n    Base,\n):\n    pass")).toBe(
      "class C(\n    Base,\n):\n    def go(self):\n        pass",
    );
  });
});
