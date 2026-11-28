import { describe, expect, it } from "vitest";
import { findLanguageDescription, loadSupport } from "./languages";

const parse = async (uiMode: string, path: string, src: string) =>
  (await loadSupport(findLanguageDescription(uiMode, path)!))!.language.parser.parse(src).toString();

describe("versioned <script> types", () => {
  it.each([
    [
      "Vue",
      "/p/a.vue",
      `<template><div/></template>\n<script type="text/ecmascript-6">\nexport default { data() { return 1 } }\n</script>`,
    ],
    ["HTML", "/p/a.html", `<script type="text/ecmascript-6">const a = () => 1;</script>`],
    ["HTML", "/p/a.html", `<script type="text/javascript1.5">var a = 1;</script>`],
  ])("parses %s %s as JavaScript", async (mode, path, src) => {
    expect(await parse(mode, path, src)).toMatch(/Script\(.*(ExportDeclaration|VariableDeclaration)/s);
  });

  it("keeps a script of another type as text", async () => {
    const tree = await parse("HTML", "/p/a.html", `<script type="text/x-template">const a = 1;</script>`);
    expect(tree).not.toContain("VariableDeclaration");
  });

  it("still parses an untyped script and a TypeScript one", async () => {
    expect(await parse("HTML", "/p/a.html", `<script>var a = 1;</script>`)).toContain("VariableDeclaration");
    const vue = await parse("Vue", "/p/a.vue", `<script lang="ts">\nlet a: number = 1;\n</script>`);
    expect(vue).toContain("TypeAnnotation");
  });
});
