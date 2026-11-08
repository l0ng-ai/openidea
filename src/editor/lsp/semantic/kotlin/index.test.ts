import { describe, expect, it } from "vitest";
import { Text } from "@codemirror/state";
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
});
