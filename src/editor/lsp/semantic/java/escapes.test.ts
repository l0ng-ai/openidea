import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { completedSyntaxTree } from "@/test/syntax";
import { findLanguageDescription, loadSupport } from "../../../core/cm/languages";
import { languageSemantics } from "../languages";
import { javaEscapeRanges } from "./escapes";
import "./index";

async function escapes(source: string) {
  const support = await loadSupport(findLanguageDescription("Java", "Demo.java")!);
  const state = EditorState.create({ doc: source, extensions: [support!] });
  const tree = completedSyntaxTree(state);
  return javaEscapeRanges(tree, state.doc).map((r) => [
    state.doc.sliceString(r.from, r.to),
    r.className === "cm-sem-escape" ? "valid" : "invalid",
  ]);
}

const wrap = (body: string) => `class A {\n  ${body}\n}\n`;

describe("Java escape sequences", () => {
  it("splits string escapes as IntelliJ does", async () => {
    const source = wrap(String.raw`String s = "a\n\t\b\r\f\s\"\'\\ \q \0 \12 \377 \400 \u0041 \uuu00e9 \u00G1 end";`);
    expect(await escapes(source)).toEqual([
      ...["\\n", "\\t", "\\b", "\\r", "\\f", "\\s", '\\"', "\\'", "\\\\"].map((e) => [e, "valid"]),
      ["\\q", "invalid"],
      ["\\0", "valid"],
      ["\\12", "valid"],
      ["\\377", "valid"],
      // `\40` then a plain `0`: an octal escape starting above 3 takes two digits at most.
      ["\\40", "valid"],
      ["\\u0041", "valid"],
      ["\\uuu00e9", "valid"],
      ["\\u00", "invalid"],
    ]);
  });

  it("covers character literals and text blocks, with line continuations", async () => {
    const source = wrap(`char c = '\\''; char d = '\\x';\n  String t = """\n    one \\\n    two\\ttwo \\q\n    """;`);
    expect(await escapes(source)).toEqual([
      ["\\'", "valid"],
      ["\\x", "invalid"],
      ["\\\n", "valid"],
      ["\\t", "valid"],
      ["\\q", "invalid"],
    ]);
  });

  it("leaves backslashes outside literals and in comments alone", async () => {
    expect(await escapes(wrap(`// "\\n" \\q\n  /* '\\t' */ int x = 1;`))).toEqual([]);
  });

  it("is Java's syntax pass", () => {
    expect(languageSemantics("java")?.syntaxRanges).toBeDefined();
  });
});
