import { describe, expect, it } from "vitest";
import { getIndentation } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { findLanguageDescription, loadSupport } from "./languages";

describe("vue language mode", () => {
  it('highlights SCSS inside <style lang="scss">', async () => {
    const desc = findLanguageDescription("Vue", "/p/a.vue")!;
    expect(desc?.name).toBe("Vue");
    const support = await loadSupport(desc);
    const src = `<template><div/></template>\n` + `<style lang="scss">\n.a { .b { color: red; } $c: 1; }\n</style>`;
    const tree = support!.language.parser.parse(src).toString();
    // SCSS-only syntax that plain CSS can't parse: a nested rule and a $-variable.
    expect(tree).toContain("SassVariableName");
    // The nested .b ruleset only parses under the Sass grammar.
    expect(tree).toMatch(/RuleSet\(ClassSelector.*RuleSet\(ClassSelector/s);
  });

  it("still parses a plain <style> block as CSS", async () => {
    const support = await loadSupport(findLanguageDescription("Vue", "/p/a.vue")!);
    const tree = support!.language.parser
      .parse(`<template><div/></template><style>.a { color: red; }</style>`)
      .toString();
    expect(tree).toContain("StyleSheet");
    expect(tree).toContain("Declaration");
    expect(tree).not.toContain("SassVariableName");
  });

  it("indents the top-level <template>'s children only, not <script setup> or <style> code", async () => {
    const support = await loadSupport(findLanguageDescription("Vue", "/p/a.vue")!);
    const doc = [
      "<template>",
      "<div>",
      "</div>",
      "</template>",
      '<script setup lang="ts">',
      "const a = 1",
      "function f() {",
      "return a",
      "}",
      "</script>",
      "<style>",
      ".a { color: red; }",
      "</style>",
    ].join("\n");
    const state = EditorState.create({ doc, extensions: [support!, EditorState.tabSize.of(2)] });
    const indent = (line: number) => getIndentation(state, state.doc.line(line).from);
    expect(indent(2)).toBe(2);
    expect(indent(6)).toBe(0);
    expect(indent(7)).toBe(0);
    expect(indent(8)).toBe(2);
    expect(indent(10)).toBe(0);
    expect(indent(12)).toBe(0);
  });
});
