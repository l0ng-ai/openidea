import { describe, expect, it } from "vitest";
import { Text } from "@codemirror/state";
import { Tree } from "@lezer/common";
import { semanticRanges } from "../index";

describe("Kotlin semantic tokens", () => {
  it.each([
    ["variable", "modification", ["cm-sem-mutable"]],
    ["property", "modification", ["cm-sem-property", "cm-sem-mutable"]],
    ["parameter", "modification", ["cm-sem-parameter", "cm-sem-mutable"]],
    ["operator", "declaration", ["cm-sem-declaration", "cm-sem-function"]],
    ["label", "", ["cm-sem-constant"]],
  ])("recognizes %s with %s", (type, modifier, expected) => {
    const tokens = { tokenTypes: [type], tokenModifiers: [modifier], data: [0, 0, 4, 0, 1] };
    const result = semanticRanges(Text.of(["name"]), tokens, false, "kotlin");
    expect(result[0]?.className.split(" ")).toEqual(expected);
  });

  it("keeps modification language-specific and leaves val properties as properties", () => {
    const doc = Text.of(["name"]);
    expect(
      semanticRanges(
        doc,
        {
          tokenTypes: ["variable"],
          tokenModifiers: ["modification"],
          data: [0, 0, 4, 0, 1],
        },
        false,
        "typescript",
      ),
    ).toEqual([]);
    expect(
      semanticRanges(
        doc,
        {
          tokenTypes: ["property"],
          tokenModifiers: ["readonly"],
          data: [0, 0, 4, 0, 1],
        },
        false,
        "kotlin",
      )[0]?.className,
    ).toBe("cm-sem-property");
  });

  it("colours annotation names as annotations, not as the constructor calls the server reports", () => {
    const lines = [
      '@Column(name = "x")',
      "@field:Inject @Outer.Inner",
      "list.forEach { return@forEach }",
      "this@Outer.call()",
    ];
    const doc = Text.of(lines);
    const types = ["method", "class", "label"];
    const tok = (line: number, word: string, type: string) => [
      line,
      lines[line]!.lastIndexOf(word),
      word.length,
      types.indexOf(type),
      0,
    ];
    const data = [
      tok(0, "Column", "method"),
      tok(1, "Inject", "class"),
      tok(1, "Outer", "class"),
      tok(1, "Inner", "class"),
      tok(2, "forEach", "label"),
      tok(3, "Outer", "class"),
    ].flat();
    const tokens = { tokenTypes: types, tokenModifiers: [], data };
    const ranges = semanticRanges(doc, tokens, false, "kotlin", Tree.empty);
    const classOf = (line: number, word: string) => {
      const from = doc.line(line + 1).from + lines[line]!.lastIndexOf(word);
      return ranges.find((r) => r.from === from)?.className;
    };
    expect(classOf(0, "Column")).toBe("cm-sem-annotation");
    expect(classOf(1, "Inject")).toBe("cm-sem-annotation");
    expect(classOf(1, "Outer")).toBe("cm-sem-annotation");
    expect(classOf(1, "Inner")).toBe("cm-sem-annotation");
    expect(classOf(2, "forEach")).toBe("cm-sem-constant");
    expect(classOf(3, "Outer")).not.toBe("cm-sem-annotation");
  });
});
