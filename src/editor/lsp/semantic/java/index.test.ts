import { describe, expect, it } from "vitest";
import { Text } from "@codemirror/state";
import { javaLanguage } from "@codemirror/lang-java";
import { semanticRanges } from "../index";
import type { SemanticRange } from "../languages";
import { javaKeywordRanges } from "./index";

const doc = Text.of(["name"]);
const token = (type: string, modifiers: string[], language: string) =>
  semanticRanges(
    doc,
    { tokenTypes: [type], tokenModifiers: modifiers, data: [0, 0, 4, 0, (1 << modifiers.length) - 1] },
    false,
    language,
  )[0]?.className.split(" ");

describe("Java semantic tokens", () => {
  it.each([
    ["class", ["cm-sem-type"]],
    ["interface", ["cm-sem-type"]],
    ["method", ["cm-sem-function"]],
  ])("colours JDK %s references like library and workspace ones", (type, classes) => {
    expect(token(type, ["defaultLibrary"], "java")).toEqual(classes);
    expect(token(type, ["defaultLibrary"], "java")).toEqual(token(type, [], "java"));
  });

  it("keeps the other modifiers of JDK symbols", () => {
    expect(token("property", ["static", "defaultLibrary"], "java")?.sort()).toEqual([
      "cm-sem-property",
      "cm-sem-static",
    ]);
  });

  it.each(["class", "interface", "enum", "record"])("does not italicise static nested %s names", (type) => {
    expect(token(type, ["static"], "java")).toEqual(["cm-sem-type"]);
  });

  it.each([
    ["property", "cm-sem-property"],
    ["method", "cm-sem-function"],
  ])("keeps static %s italic", (type, cls) => {
    expect(token(type, ["static"], "java")?.sort()).toEqual([cls, "cm-sem-static"]);
  });

  it("keeps static types italic in other languages", () => {
    expect(token("class", ["static"], "python")).toContain("cm-sem-static");
  });

  it("leaves defaultLibrary colouring to other languages", () => {
    expect(token("function", ["defaultLibrary"], "python")).toContain("cm-sem-builtin");
  });
});

describe("Java contextual keywords", () => {
  const source = [
    "sealed interface Shape permits Circle, Square {}",
    "record Circle(double r) implements Shape {}",
    "non-sealed class Square implements Shape {}",
    "class T {",
    "  int area(Shape s, int yield, int when, int record) {",
    "    var a = 1;",
    "    yield = 2;",
    "    when = yield + when;",
    "    return switch (s) {",
    "      case Circle c when c.r() > 1 -> 3;",
    "      case Circle(double r) when r > 0 -> { yield -1; }",
    "      default -> { int x = record; yield x; }",
    "    };",
    "  }",
    "}",
  ];
  const doc = Text.of(source);
  const tree = javaLanguage.parser.parse(doc.toString());
  const words = (ranges: SemanticRange[]) =>
    ranges
      .filter((r) => r.className === "cm-sem-keyword")
      .map((r) => `${doc.lineAt(r.from).number}:${doc.sliceString(r.from, r.to)}`);

  it("colours them only where they are keywords, not names", () => {
    expect(words(javaKeywordRanges(tree, doc))).toEqual([
      "1:sealed",
      "1:permits",
      "2:record",
      "3:non-sealed",
      "6:var",
      "10:when",
      "11:when",
      "11:yield",
      "12:yield",
    ]);
  });

  it("keeps them keywords over jdtls tokens", () => {
    const at = (line: number, word: string) => [line - 1, source[line - 1]!.indexOf(word), word.length];
    const data = [...at(1, "sealed"), 0, 0, ...at(3, "non-sealed"), 0, 0, ...at(6, "var"), 1, 0];
    const ranges = semanticRanges(
      doc,
      { tokenTypes: ["modifier", "type"], tokenModifiers: [], data },
      false,
      "java",
      tree,
    );
    expect(words(ranges)).toContain("3:non-sealed");
    expect(ranges.filter((r) => r.className.includes("cm-sem-type"))).toEqual([]);
    expect(
      semanticRanges(
        Text.of(["sealed"]),
        { tokenTypes: ["modifier"], tokenModifiers: [], data: [0, 0, 6, 0, 0] },
        false,
        "java",
      ),
    ).toEqual([{ from: 0, to: 6, className: "cm-sem-keyword" }]);
  });
});
