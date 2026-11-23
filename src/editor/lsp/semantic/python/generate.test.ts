import { describe, expect, it } from "vitest";
import { indentUnit } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { classFields, initText, instanceAttributes, propertyText } from "./generate";
import { insertMembers } from "./members";

const src = `from typing import ClassVar


class Point:
    """A point.

    x = not a field
    """

    registry: ClassVar[dict] = {}
    __slots__ = ("x", "y")
    x: float
    y: float = 0.0
    label = "p"

    def __init__(self, name: str, size):
        self.name = name
        self._size: int = size
        self.cache = {}

    def move(self, dx):
        self.x += dx
        self.cache = None
`.split("\n");

describe("python generate", () => {
  it("lists the class fields, not class variables, dunders or docstring text", () => {
    expect(classFields(src, 4)).toEqual([
      { name: "x", annotation: "float", value: null },
      { name: "y", annotation: "float", value: "0.0" },
      { name: "label", annotation: null, value: '"p"' },
    ]);
  });

  it("writes __init__ with the fields that have a value last", () => {
    expect(initText(classFields(src, 4), "    ", "    ")).toBe(
      [
        '    def __init__(self, x: float, y: float = 0.0, label="p"):',
        "        self.x = x",
        "        self.y = y",
        "        self.label = label",
      ].join("\n"),
    );
    expect(initText([], "", "    ")).toBe("def __init__(self):\n    pass");
  });

  it("finds instance attributes with the annotation of the parameter they come from", () => {
    expect(instanceAttributes(src, 4)).toEqual([
      { name: "name", annotation: "str", value: null },
      { name: "_size", annotation: "int", value: null },
      { name: "cache", annotation: null, value: null },
    ]);
  });

  it("writes a property and its setter over a private field", () => {
    expect(propertyText({ name: "_size", annotation: "int", value: null }, "    ", "    ")).toBe(
      [
        "    @property",
        "    def size(self) -> int:",
        "        return self._size",
        "",
        "    @size.setter",
        "    def size(self, value: int) -> None:",
        "        self._size = value",
      ].join("\n"),
    );
    expect(propertyText({ name: "cache", annotation: null, value: null }, "", "  ")).toBe(
      "@property\ndef cache(self):\n  return self._cache\n\n@cache.setter\ndef cache(self, value):\n  self._cache = value",
    );
  });
});

describe("python generate insertion", () => {
  it("puts __init__ after the fields, before the first method", () => {
    const view = new EditorView({
      state: EditorState.create({
        doc: "class A:\n    x: int\n\n    @property\n    def y(self):\n        return 1\n",
        extensions: indentUnit.of("    "),
      }),
    });
    insertMembers(
      view,
      view.state.doc.toJSON(),
      1,
      (indent, unit) => initText(classFields(["class A:", "    x: int"], 1), indent, unit),
      [],
      true,
    );
    expect(view.state.doc.toString()).toBe(
      "class A:\n    x: int\n\n    def __init__(self, x: int):\n        self.x = x\n\n    @property\n    def y(self):\n        return 1\n",
    );
    view.destroy();
  });
});
