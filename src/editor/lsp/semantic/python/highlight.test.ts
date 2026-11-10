import { describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { completedSyntaxTree } from "@/test/syntax";
import { findLanguageDescription, loadSupport } from "../../../core/cm/languages";
import { pythonSyntaxRanges, pythonFallbackRanges, pythonSymbolKinds } from "./highlight";
import { semanticRanges } from "../index";

async function parse(source: string) {
  const support = await loadSupport(findLanguageDescription("Python", "demo.py")!);
  const state = EditorState.create({ doc: source, extensions: [support!] });
  return { doc: state.doc, tree: completedSyntaxTree(state) };
}

describe("Python PyCharm categories", () => {
  it("uses the completed tree when initial parsing exceeds its time budget", async () => {
    await parse("");
    // Exceed the initial 20 ms parse budget, but stay within ensureSyntaxTree's budget.
    let now = 0;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => (now += 25));
    try {
      const state = await parse("def f(self):\n    value = b'bytes'\n    self.run(whatever=1)\n");
      expect(state.tree.length).toBe(state.doc.length);
      const styles = pythonSyntaxRanges(state.tree, state.doc).map((r) => [
        state.doc.sliceString(r.from, r.to),
        r.className,
      ]);
      expect(styles).toContainEqual(["whatever", "cm-sem-python-keyword-arg"]);
    } finally {
      clock.mockRestore();
    }
  });

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
    const ranges = pythonSyntaxRanges(state.tree, state.doc);
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
    const ranges = pythonFallbackRanges(state.tree, state.doc);
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
    const tree = state.tree;
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
    const stubKinds = pythonSymbolKinds(stubs.tree, stubs.doc);
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
      state.tree,
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
      state.tree,
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
    expect(pythonSyntaxRanges(state.tree, state.doc).some((r) => r.className === "cm-sem-python-docstring")).toBe(
      false,
    );
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
    const tree = state.tree;
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
      state.tree,
    );
    const classOf = (name: string) =>
      result.filter((range) => state.doc.sliceString(range.from, range.to) === name).map((range) => range.className);
    expect(classOf("MAX_SIZE")).toEqual(["cm-sem-constant cm-sem-python-constant"]);
    expect(classOf("local")[0]).toContain("cm-sem-variable cm-sem-python-local-variable cm-sem-rainbow-");
    expect(classOf("local")[1]).toContain("cm-sem-python-local-variable");
    expect(classOf("MAX_SIZE")[0]).not.toContain("cm-sem-rainbow-");
  });
});

describe("Python docstring markup formats", () => {
  async function markup(format: string, source: string) {
    const state = await parse(source);
    return pythonSyntaxRanges(state.tree, state.doc, undefined, format)
      .filter((r) => r.className.startsWith("cm-sem-python-docstring-"))
      .map((r) => [state.doc.sliceString(r.from, r.to), r.className]);
  }

  it("highlights reStructuredText fields and directives", async () => {
    const styles = await markup(
      "rest",
      `"""Load things.

:param x: name to load
:returns: loaded value
.. note:: results are cached
"""`,
    );
    expect(styles).toContainEqual(["param", "cm-sem-python-docstring-tag"]);
    expect(styles).toContainEqual(["x", "cm-sem-python-docstring-keyword"]);
    expect(styles).toContainEqual(["returns", "cm-sem-python-docstring-tag"]);
    expect(styles).toContainEqual(["note::", "cm-sem-python-docstring-tag"]);
  });

  it("highlights Epytext fields", async () => {
    const styles = await markup(
      "epytext",
      `"""Load things.

@param x: name to load
@type x: str
@return: loaded value
"""`,
    );
    expect(styles).toContainEqual(["param", "cm-sem-python-docstring-tag"]);
    expect(styles).toContainEqual(["x", "cm-sem-python-docstring-keyword"]);
    expect(styles).toContainEqual(["type", "cm-sem-python-docstring-tag"]);
    expect(styles).toContainEqual(["return", "cm-sem-python-docstring-tag"]);
  });

  it("highlights Google sections and entries", async () => {
    const styles = await markup(
      "google",
      `"""Load things.

Args:
    x (int): first
    y: second

Returns:
    Nothing.
"""`,
    );
    expect(styles).toContainEqual(["Args", "cm-sem-python-docstring-tag"]);
    expect(styles).toContainEqual(["x", "cm-sem-python-docstring-keyword"]);
    expect(styles).toContainEqual(["y", "cm-sem-python-docstring-keyword"]);
    expect(styles).toContainEqual(["Returns", "cm-sem-python-docstring-tag"]);
  });

  it("highlights NumPy sections and entries", async () => {
    const styles = await markup(
      "numpy",
      `"""Load things.

Parameters
----------
x : int
    name to load

Returns
-------
str
    loaded value.
"""`,
    );
    expect(styles).toContainEqual(["Parameters", "cm-sem-python-docstring-tag"]);
    expect(styles).toContainEqual(["x", "cm-sem-python-docstring-keyword"]);
    expect(styles).toContainEqual(["Returns", "cm-sem-python-docstring-tag"]);
  });

  it("leaves docstrings unmarked when the format is plain", async () => {
    const styles = await markup(
      "plain",
      `"""Load things.

:param x: name to load
"""`,
    );
    expect(styles).toEqual([]);
  });

  it.each(["rest", "epytext"])("highlights %s fields on the opening line in UTF-16 coordinates", async (format) => {
    const marker = format === "rest" ? ":" : "@";
    const source = `# 😀\ndef f():\n    r"""${marker}param 名称: 😀 description"""\n`;
    const state = await parse(source);
    const ranges = pythonSyntaxRanges(state.tree, state.doc, undefined, format);
    for (const [value, suffix] of [
      ["param", "tag"],
      ["名称", "keyword"],
    ]) {
      const from = source.indexOf(value!);
      expect(ranges).toContainEqual({
        from,
        to: from + value!.length,
        className: `cm-sem-python-docstring-${suffix}`,
        source: "syntax",
      });
    }
  });

  it.each(["b", "br", "rb", "B", "Rb", "f", "fr", "rf"])("never marks %s strings as docstrings", async (prefix) => {
    expect(await markup("rest", `${prefix}"""Description.\n:param x: value\n"""`)).toEqual([]);
  });

  it("restricts markup to the first statement of modules, classes and functions", async () => {
    const source = `# 😀 module\n"""Description.\n:param module: value\n"""
class C:
    # comment
    """Description.
    :param cls: value
    """
    def f(self):
        """Description.
        :param func: value
        """
        value = """Description.
        :param assigned: value
        """
        """Description.
        :param later: value
        """
if True:
    """Description.
    :param conditional: value
    """
`;
    const styles = await markup("rest", source);
    expect(styles.filter(([, c]) => c?.endsWith("-keyword")).map(([value]) => value)).toEqual([
      "module",
      "cls",
      "func",
    ]);
  });

  it("requires indented content after a Google section heading", async () => {
    expect(await markup("google", '"""Description.\nArgs:\nNot a section.\nNotes:\n"""')).toEqual([]);
  });

  it.each([
    ["google", "Args:\n    𐐀名称 (int): value"],
    ["numpy", "Parameters\n----------\n𐐀名称 : int\n    value"],
  ])("keeps %s keyword ranges in UTF-16 for Unicode names", async (format, content) => {
    const source = `"""😀 Description.\n${content}\n"""`;
    const state = await parse(source);
    const from = source.indexOf("𐐀名称");
    expect(pythonSyntaxRanges(state.tree, state.doc, undefined, format)).toContainEqual({
      from,
      to: from + "𐐀名称".length,
      className: "cm-sem-python-docstring-keyword",
      source: "syntax",
    });
  });

  it.each(["rest", "epytext", "google", "numpy"])("handles long unfinished %s fields", async (format) => {
    const source = `"""Description.\n:param ${" ".repeat(2000)}unfinished\nArgs:\nParameters\n----------\nx${" ".repeat(2000)}unfinished\n"""`;
    expect(await markup(format, source)).not.toContainEqual(["unfinished", "cm-sem-python-docstring-keyword"]);
  });
});
