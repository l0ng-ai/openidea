import { describe, expect, it } from "vitest";
import { Text } from "@codemirror/state";
import { javaLanguage } from "@codemirror/lang-java";
import { languageSemantics } from "../languages";
import "./index";

function strings(source: string): string[] {
  const doc = Text.of(source.split("\n"));
  const ranges = languageSemantics("java")!.syntaxRanges!(javaLanguage.parser.parse(source), doc, new Map());
  return ranges
    .filter((r) => r.className === "cm-sem-java-unterminated-string")
    .map((r) => doc.sliceString(r.from, r.to));
}

describe("Java unterminated literals", () => {
  it("colours an unterminated string to the end of its line, and not the next line", () => {
    expect(strings('class A {\n  String s = "abc;\n  int x = 1;\n}')).toEqual(['"abc;']);
  });

  it("colours one at the end of the file", () => {
    expect(strings('class A { String s = "abc')).toEqual(['"abc']);
  });

  it("colours one in an annotation argument", () => {
    expect(strings('@SuppressWarnings("unused)\nclass A {}')).toEqual(['"unused)']);
  });

  it("colours an unterminated char literal and skips escaped quotes", () => {
    expect(strings("class A { char c = 'a;\n}")).toEqual(["'a;"]);
    expect(strings("class A { char c = '\\'; }")).toEqual(["'\\'; }"]);
    expect(strings('class A { String s = "a\\"b; }')).toEqual(['"a\\"b; }']);
  });

  it("stops a malformed char literal at its closing quote", () => {
    expect(strings("class A { char c = 'ab'; }")).toEqual(["'ab'"]);
  });

  it("leaves closed literals and quotes in comments alone", () => {
    expect(
      strings(
        'class A {\n  // say "hi\n  /* it\'s */ String s = "x"; char q = \'"\';\n  String t = """\n    a\n    """;\n}',
      ),
    ).toEqual([]);
  });

  it("leaves an unterminated text block to the parser, which runs it to the end of the file", () => {
    expect(strings('class A {\n  String t = """\n    abc "q" \\n\n  int x = 1;\n}\n')).toEqual([]);
    expect(strings('class A { String t = """\n')).toEqual([]);
  });

  it('colours only the quote after `""` when a text block opener has no line break', () => {
    expect(strings('class A { String t = """; }')).toEqual(['"; }']);
  });

  it("starts after a closed string on the same line", () => {
    expect(strings('class A { String s = "a" + "bc; }')).toEqual(['"bc; }']);
  });
});
