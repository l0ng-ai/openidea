import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { findLanguageDescription, loadSupport } from "../core/cm/languages";
import { pythonSyntaxRanges, pythonFallbackRanges } from "./pythonHighlight";
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
});
