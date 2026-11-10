import { describe, expect, it } from "vitest";
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
});
