import { describe, expect, it } from "vitest";
import { Text } from "@codemirror/state";
import { semanticRanges } from "../index";

const doc = Text.of(["std"]);
const token = (type: string, modifiers: string[], language = "cpp") =>
  semanticRanges(
    doc,
    { tokenTypes: [type], tokenModifiers: modifiers, data: [0, 0, 3, 0, (1 << modifiers.length) - 1] },
    false,
    language,
  )[0]?.className.split(" ");

describe("C++ namespace semantic tokens", () => {
  it.each(["cpp", "CPP"])("keeps standard-library namespaces in the namespace colour (%s)", (language) => {
    expect(token("namespace", ["defaultLibrary", "globalScope"], language)).toEqual(["cm-sem-namespace"]);
    expect(token("namespace", ["defaultLibrary"], language)).toEqual(token("namespace", [], language));
  });

  it("preserves namespace declaration and deprecation styles", () => {
    expect(token("namespace", ["defaultLibrary", "declaration", "deprecated"])).toEqual([
      "cm-sem-namespace",
      "cm-sem-declaration",
      "cm-sem-deprecated",
    ]);
  });

  it.each(["class", "function", "variable"])("preserves builtin colouring for %s tokens", (type) => {
    expect(token(type, ["defaultLibrary"])).toContain("cm-sem-builtin");
  });

  it("leaves other languages' namespace colouring unchanged", () => {
    expect(token("namespace", ["defaultLibrary"], "rust")).toEqual(["cm-sem-namespace", "cm-sem-builtin"]);
  });
});
