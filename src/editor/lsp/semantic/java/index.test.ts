import { describe, expect, it } from "vitest";
import { Text } from "@codemirror/state";
import { semanticRanges } from "../index";

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

  it("leaves defaultLibrary colouring to other languages", () => {
    expect(token("function", ["defaultLibrary"], "python")).toContain("cm-sem-builtin");
  });
});
