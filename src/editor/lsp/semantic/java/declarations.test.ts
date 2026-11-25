import { describe, expect, it } from "vitest";
import { Text } from "@codemirror/state";
import { javaLanguage } from "@codemirror/lang-java";
import { semanticRanges } from "../index";
import { javaDeclarationRanges } from "./declarations";

const SRC = `class A {
  private int count, total = 1;
  static String name;
  private final int code = 0;
  final static long SERIAL = 1L;
  public static final int MAX = 10;
  A() {}
  static void helper() { int local = 0; count = local; }
  <T> T id(T t) { return t; }
  enum Level { LOW, HIGH(2) { void f() {} }; Level() {} }
  interface I { int C = 1; void m(); static void s() {} }
}`;

const tree = javaLanguage.parser.parse(SRC);
const doc = Text.of(SRC.split("\n"));
const named = (ranges: Array<{ from: number; to: number; className: string }>) =>
  Object.fromEntries(ranges.map((r) => [SRC.slice(r.from, r.to), r.className]));

describe("javaDeclarationRanges", () => {
  it("colours declaration names as jdtls does, and nothing else", () => {
    expect(named(javaDeclarationRanges(tree))).toEqual({
      count: "cm-sem-property cm-sem-declaration",
      total: "cm-sem-property cm-sem-declaration",
      name: "cm-sem-property cm-sem-static cm-sem-declaration",
      code: "cm-sem-property cm-sem-declaration",
      SERIAL: "cm-sem-property cm-sem-static cm-sem-declaration",
      MAX: "cm-sem-property cm-sem-static cm-sem-declaration",
      A: "cm-sem-function cm-sem-declaration",
      helper: "cm-sem-function cm-sem-static cm-sem-declaration",
      id: "cm-sem-function cm-sem-declaration",
      LOW: "cm-sem-constant cm-sem-static cm-sem-declaration",
      HIGH: "cm-sem-constant cm-sem-static cm-sem-declaration",
      f: "cm-sem-function cm-sem-declaration",
      Level: "cm-sem-function cm-sem-declaration",
      C: "cm-sem-property cm-sem-static cm-sem-declaration",
      m: "cm-sem-function cm-sem-declaration",
      s: "cm-sem-function cm-sem-static cm-sem-declaration",
    });
  });

  it("is shown without server tokens and gives way to them", () => {
    const empty = { data: [], tokenTypes: [], tokenModifiers: [] };
    expect(named(semanticRanges(doc, empty, false, "java", tree)).count).toBe("cm-sem-property cm-sem-declaration");
    // A jdtls token over `count` (line 1, col 14) replaces the fallback.
    const tokens = { data: [1, 14, 5, 0, 0], tokenTypes: ["property"], tokenModifiers: [] };
    const count = semanticRanges(doc, tokens, false, "java", tree).filter((r) => SRC.slice(r.from, r.to) === "count");
    expect(count.map((r) => r.className)).toEqual(["cm-sem-property"]);
  });

  it("matches the classes of jdtls's own declaration tokens", () => {
    // MAX (line 5, col 26) and C (line 10, col 20), as jdtls sends them; IDEA colours `static final` fields as static fields.
    const mods = ["static", "readonly", "declaration"];
    const tokens = { data: [5, 26, 3, 0, 7, 10, 20, 1, 0, 7], tokenTypes: ["property"], tokenModifiers: mods };
    const fallback = named(javaDeclarationRanges(tree));
    const server = named(semanticRanges(doc, tokens, false, "java", tree).filter((r) => !("source" in r)));
    expect(server).toEqual({ MAX: fallback.MAX, C: fallback.C });
  });
});
