import { describe, expect, it } from "vitest";
import { indentUnit } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { classFields, generatesOwnInit, initText, instanceAttributes, propertyText } from "./generate";
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

describe("python generate review cases", () => {
  it("reads values with # in strings, skips multi-line values, reads non-ASCII names", () => {
    const lines = [
      "class Theme:",
      '    color = "#fff"  # hex',
      '    prefix: str = "#"',
      "    CHOICES = [",
      '        "a",',
      "    ]",
      '    doc = """multi',
      '    line"""',
      "    größe: int = 1",
      "    ok: bool = x == y",
    ];
    expect(classFields(lines, 1)).toEqual([
      { name: "color", annotation: null, value: '"#fff"' },
      { name: "prefix", annotation: "str", value: '"#"' },
      { name: "größe", annotation: "int", value: "1" },
      { name: "ok", annotation: "bool", value: "x == y" },
    ]);
  });

  it("keeps a name-mangled or private attribute as the property's field", () => {
    const text = propertyText({ name: "__secret", annotation: null, value: null }, "", "    ");
    expect(text).toContain("def secret(self):\n    return self.__secret");
    expect(text).toContain("    self.__secret = value");
    expect(instanceAttributes(["class A:", "    def __init__(self, maß: int):", "        self.maß = maß"], 1)).toEqual([
      { name: "maß", annotation: "int", value: null },
    ]);
  });

  it("puts __init__ before the first method, not in an Epytext docstring", () => {
    const view = new EditorView({
      state: EditorState.create({
        doc: 'class A:\n    """Doc.\n\n    @ivar x: the x\n    """\n\n    x: int\n\n    def y(self):\n        return 1\n',
        extensions: indentUnit.of("    "),
      }),
    });
    insertMembers(
      view,
      view.state.doc.toJSON(),
      1,
      (indent, unit) => `${indent}def __init__(self):\n${indent}${unit}pass`,
      [],
      true,
    );
    expect(view.state.doc.toString()).toBe(
      'class A:\n    """Doc.\n\n    @ivar x: the x\n    """\n\n    x: int\n\n    def __init__(self):\n        pass\n\n    def y(self):\n        return 1\n',
    );
    view.destroy();
  });

  it("recognises classes that make their own __init__", () => {
    expect(generatesOwnInit(["from enum import Enum", "class C(Enum):", "    A = 1"], 2)).toBe(true);
    expect(generatesOwnInit(["class P(typing.NamedTuple):", "    x: int"], 1)).toBe(true);
    expect(generatesOwnInit(["class M(BaseModel):", "    x: int"], 1)).toBe(true);
    expect(generatesOwnInit(["@dataclass(frozen=True)", "class D:", "    x: int"], 2)).toBe(true);
    expect(generatesOwnInit(["@attrs.define", "class D:", "    x: int"], 2)).toBe(true);
    expect(generatesOwnInit(["class Plain(Base):", "    x: int"], 1)).toBe(false);
  });
});
