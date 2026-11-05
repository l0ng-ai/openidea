import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { findLanguageDescription, loadSupport } from "../core/cm/languages";
import { pythonSyntaxRanges, pythonFallbackRanges, pythonSymbolKinds } from "./pythonHighlight";
import { semanticRanges } from "./semantic";

async function parse(source: string) {
  const support = await loadSupport(findLanguageDescription("Python", "demo.py")!);
  const state = EditorState.create({ doc: source, extensions: [support!] });
  ensureSyntaxTree(state, state.doc.length, 1000);
  return state;
}

describe("Python PyCharm categories", () => {
  it("distinguishes definitions, nested definitions, docstrings, self, bytes and keyword arguments", async () => {
    const state = await parse(`"""module doc"""
def outer(x):
    """function doc"""
    def nested(y):
        return y
    nested(x)
class Foo:
    """class doc"""
    def __init__(self):
        value = b"bytes\\n"
        self.run(whatever=1)
        print(self.__doc__)
`);
    const ranges = pythonSyntaxRanges(syntaxTree(state), state.doc);
    const styles = ranges.map((r) => [state.doc.sliceString(r.from, r.to), r.className]);
    expect(styles).toContainEqual(["outer", "cm-sem-python-definition"]);
    expect(styles).toContainEqual(["nested", "cm-sem-python-nested"]);
    expect(styles).toContainEqual(["__init__", "cm-sem-python-predefined-definition"]);
    expect(styles).toContainEqual(["whatever", "cm-sem-python-keyword-arg"]);
    expect(styles).toContainEqual(["__doc__", "cm-sem-python-predefined-usage"]);
    expect(styles.filter(([, c]) => c === "cm-sem-python-docstring")).toHaveLength(3);
    expect(styles.filter(([, c]) => c === "cm-sem-self")).toHaveLength(3);
    expect(styles).toContainEqual(['b"bytes\\n"', "cm-sem-python-bytes"]);
    expect(styles).toContainEqual(["\\n", "cm-sem-python-escape"]);
  });

  it("does not treat a locally shadowed builtin as a library symbol", async () => {
    const state = await parse("def f(print):\n    print(1)\nlen([1])");
    const ranges = pythonFallbackRanges(syntaxTree(state), state.doc);
    const print = ranges.filter((r) => state.doc.sliceString(r.from, r.to) === "print");
    expect(print.map((r) => r.className)).toEqual(["cm-sem-parameter", "cm-sem-parameter"]);
    expect(ranges.find((r) => state.doc.sliceString(r.from, r.to) === "len")?.className).toContain(
      "cm-sem-python-builtin",
    );
  });

  it("marks unused parameters and highlights type and f-string keywords", async () => {
    const state = await parse(`type Alias = list[int]
s = f"value={1}"
def used(x):
    return x
def unused(param):
    return 1
def skipped(self, _hidden):
    return 1
`);
    const tree = syntaxTree(state);
    const kinds = pythonSymbolKinds(tree, state.doc);
    const kindOf = (name: string) =>
      [...kinds]
        .filter(([range]) => {
          const [from, to] = range.split(":").map(Number);
          return state.doc.sliceString(from!, to!) === name;
        })
        .map(([, kind]) => kind);
    expect(kindOf("param")).toEqual(["unusedParameter"]);
    expect(kindOf("x")).toEqual(["parameter", "parameter"]);
    expect(kindOf("self")).toEqual(["parameter"]);
    expect(kindOf("_hidden")).toEqual(["parameter"]);

    // Signatures dictated elsewhere: stubs, abstract / overloaded methods, dunders, overrides.
    const stubs = await parse(`from abc import abstractmethod
class Plain:
    def method(self, unused_a):
        return 1
    def stub(self, stub_a):
        """Doc."""
        ...
    def todo(self, todo_a):
        raise NotImplementedError
    def nothing(self, pass_a): pass
    @abstractmethod
    def abstract(self, abstract_a):
        return 1
    def __exit__(self, exc_type, exc, tb):
        return None
class Child(Plain):
    def method(self, override_a):
        return 2
`);
    const stubKinds = pythonSymbolKinds(syntaxTree(stubs), stubs.doc);
    const stubKindOf = (name: string) =>
      [...stubKinds]
        .filter(([range]) => {
          const [from, to] = range.split(":").map(Number);
          return stubs.doc.sliceString(from!, to!) === name;
        })
        .map(([, kind]) => kind);
    expect(stubKindOf("unused_a")).toEqual(["unusedParameter"]);
    for (const name of ["stub_a", "todo_a", "pass_a", "abstract_a", "exc_type", "tb", "override_a"])
      expect(stubKindOf(name), name).toEqual(["parameter"]);

    const ranges = pythonSyntaxRanges(tree, state.doc, kinds);
    const styles = ranges.map((r) => [state.doc.sliceString(r.from, r.to), r.className]);
    expect(styles).toContainEqual(["param", "cm-sem-parameter cm-sem-unused"]);
    expect(styles).toContainEqual(["type", "cm-sem-keyword"]);
    const fstring = ranges.filter((r) => r.className === "cm-sem-python-fstring");
    expect(fstring.length).toBeGreaterThan(0);
    expect(fstring.some((r) => state.doc.sliceString(r.from, r.to).includes("value="))).toBe(true);
  });

  it("lets server classification override the local builtin guess", async () => {
    const state = await parse("print(1)");
    const ranges = semanticRanges(
      state.doc,
      { tokenTypes: ["variable"], tokenModifiers: [], data: [0, 0, 5, 0, 0] },
      false,
      "python",
      syntaxTree(state),
    );
    expect(ranges.some((r) => r.className.includes("python-builtin"))).toBe(false);
  });

  it("keeps calls yellow when Pyrefly omits declaration modifiers", async () => {
    const state = await parse("def outer(x):\n    outer(x)");
    const result = semanticRanges(
      state.doc,
      {
        tokenTypes: ["function"],
        tokenModifiers: [],
        data: [0, 4, 5, 0, 0, 1, 4, 5, 0, 0],
      },
      false,
      "python",
      syntaxTree(state),
    );
    expect(result.filter((r) => state.doc.sliceString(r.from, r.to) === "outer").map((r) => r.className)).toEqual([
      "cm-sem-python-definition",
      "cm-sem-function",
    ]);
  });

  it("does not misclassify ordinary strings, later expressions, bytes or f strings as docstrings", async () => {
    const state = await parse(
      'x = "ordinary"\n"later"\ndef f():\n    b"bytes"\n    "later"\ndef g():\n    f"format {x}"',
    );
    expect(
      pythonSyntaxRanges(syntaxTree(state), state.doc).some((r) => r.className === "cm-sem-python-docstring"),
    ).toBe(false);
  });

  it("honours Pyrefly selfParameter modifiers without applying rainbow colours", async () => {
    const state = await parse("self arg");
    const result = semanticRanges(
      state.doc,
      {
        tokenTypes: ["parameter"],
        tokenModifiers: ["selfParameter"],
        data: [0, 0, 4, 0, 1, 0, 5, 3, 0, 0],
      },
      true,
      "python",
    );
    expect(result[0]?.className).toBe("cm-sem-parameter cm-sem-self");
    expect(result[1]?.className).toContain("cm-sem-rainbow-");
  });

  it("classifies Python variables, attributes, properties, constants and type parameters", async () => {
    const state = await parse(`MAX_SIZE: Final = 10
name = "x"
T = TypeVar("T")
type Alias[U] = list[U]

class Box[T]:
    count = 0
    ICON: Final = "box"

    def __init__(self, value: T):
        self.value = value
        local = 1
        self.count
        self.value
        self.size

    @property
    def size(self) -> T:
        return self.value

    def read(self) -> T:
        return Box.count + Box.ICON
`);
    const tree = syntaxTree(state);
    const kinds = pythonSymbolKinds(tree, state.doc);
    const kindOf = (name: string) =>
      [...kinds]
        .filter(([range]) => {
          const [from, to] = range.split(":").map(Number);
          return state.doc.sliceString(from!, to!) === name;
        })
        .map(([, kind]) => kind);
    expect(kindOf("local")).toEqual(["localVariable"]);
    expect(kindOf("name")).toEqual(["globalVariable"]);
    expect(kindOf("MAX_SIZE")).toEqual(["constant"]);
    expect(kindOf("value")).toContain("instanceAttribute");
    expect(kindOf("count")).toContain("classAttribute");
    expect(kindOf("ICON")).toContain("constant");
    expect(kindOf("size")).toContain("property");
    expect(kindOf("T")).toEqual(expect.arrayContaining(["typeParameter"]));
    expect(kindOf("U")).toEqual(["typeParameter", "typeParameter"]);

    const syntax = pythonSyntaxRanges(tree, state.doc, kinds);
    const syntaxClass = (name: string) =>
      syntax.filter((range) => state.doc.sliceString(range.from, range.to) === name).map((range) => range.className);
    expect(syntaxClass("size")).toContain("cm-sem-property cm-sem-python-property");
    expect(syntaxClass("T")).toContain("cm-sem-typeParameter cm-sem-python-type-parameter");
  });

  it("keeps Pyrefly tokens but applies the finer Python category", async () => {
    const state = await parse("MAX_SIZE: Final = 10\ndef f(x):\n    local = x\n    return local");
    const result = semanticRanges(
      state.doc,
      {
        tokenTypes: ["variable"],
        tokenModifiers: [],
        data: [0, 0, 8, 0, 0, 2, 4, 5, 0, 1, 3, 11, 5, 0, 2],
      },
      true,
      "python",
      syntaxTree(state),
    );
    const classOf = (name: string) =>
      result.filter((range) => state.doc.sliceString(range.from, range.to) === name).map((range) => range.className);
    expect(classOf("MAX_SIZE")).toEqual(["cm-sem-constant cm-sem-python-constant"]);
    expect(classOf("local")[0]).toContain("cm-sem-variable cm-sem-python-local-variable cm-sem-rainbow-");
    expect(classOf("local")[1]).toContain("cm-sem-python-local-variable");
    expect(classOf("MAX_SIZE")[0]).not.toContain("cm-sem-rainbow-");
  });
});
