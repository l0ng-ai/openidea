import { describe, expect, it } from "vitest";
import { Text } from "@codemirror/state";
import { semanticRanges } from "../index";

const doc = Text.of(["name"]);
describe("Go semantic tokens", () => {
  it.each([
    [["readonly"], ["cm-sem-constant"]],
    [["static"], ["cm-sem-global", "cm-sem-static"]],
    [
      ["readonly", "static"],
      ["cm-sem-constant", "cm-sem-static"],
    ],
    [
      ["constant", "static"],
      ["cm-sem-constant", "cm-sem-static"],
    ],
  ])("classifies variable modifiers %j", (modifiers, classes) => {
    const ranges = semanticRanges(
      doc,
      {
        tokenTypes: ["variable"],
        tokenModifiers: modifiers,
        data: [0, 0, 4, 0, (1 << modifiers.length) - 1],
      },
      false,
      "go",
    );
    expect(ranges[0]?.className.split(" ").sort()).toEqual(classes);
  });

  it("keeps local constants out of rainbow coloring and scopes readonly to Go", () => {
    const tokens = { tokenTypes: ["variable"], tokenModifiers: ["readonly"], data: [0, 0, 4, 0, 1] };
    expect(semanticRanges(doc, tokens, true, "go")[0]?.className).toBe("cm-sem-constant");
    expect(semanticRanges(doc, tokens, false, "typescript")).toEqual([]);
    expect(semanticRanges(doc, { ...tokens, data: [0, 0, 4, 0, 0] }, true, "go")[0]?.className).toContain(
      "cm-sem-rainbow-",
    );
    expect(semanticRanges(doc, { ...tokens, tokenTypes: ["parameter"] }, true, "go")[0]?.className).toContain(
      "cm-sem-rainbow-",
    );
  });

  it("retains package, field and function roles from the common decoder", () => {
    for (const [type, expected] of [
      ["namespace", "cm-sem-namespace"],
      ["property", "cm-sem-property"],
      ["function", "cm-sem-function"],
      ["type", "cm-sem-type"],
      ["typeParameter", "cm-sem-typeParameter"],
    ]) {
      expect(
        semanticRanges(doc, { tokenTypes: [type!], tokenModifiers: [], data: [0, 0, 4, 0, 0] }, false, "go")[0]
          ?.className,
      ).toBe(expected);
    }
  });

  it("leaves branch labels and missing server tokens to syntax highlighting", () => {
    expect(
      semanticRanges(doc, { tokenTypes: ["label"], tokenModifiers: [], data: [0, 0, 4, 0, 0] }, false, "go"),
    ).toEqual([]);
    expect(semanticRanges(doc, { tokenTypes: [], tokenModifiers: [], data: [] }, true, "go")).toEqual([]);
  });
});
