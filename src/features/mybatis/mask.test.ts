import { describe, expect, it } from "vitest";
import { blankOut, colAt, lineAt, scanJava, scanXml, type MaskSource } from "./mask";

/** `text` with every masked run shown as `#`. */
function masked(text: string, ranges: MaskSource): string {
  const chars = text.split("");
  for (const [from, to] of ranges) {
    for (let i = from; i < to && i < chars.length; i++) {
      if (chars[i] !== "\n") chars[i] = "#";
    }
  }
  return chars.join("");
}

const java = (text: string) => masked(text, scanJava(text));
const xml = (text: string) => masked(text, scanXml(text));

describe("blankOut", () => {
  it("preserves length and line breaks", () => {
    const text = 'int a = 1; // tail\n"x"';
    const out = blankOut(text, scanJava(text));
    expect(out).toHaveLength(text.length);
    expect(out.split("\n")).toHaveLength(text.split("\n").length);
    expect(out).toContain("\n");
  });

  it("is a no-op without ranges", () => {
    expect(blankOut("plain", [])).toBe("plain");
  });
});

describe("scanJava", () => {
  it("masks a line comment to the end of the line", () => {
    expect(java("// comment")).toBe("#".repeat(10));
    expect(java("// don't do this\nint x = 1;")).toBe(`${"#".repeat(16)}\nint x = 1;`);
  });

  it("masks a string literal, so a // inside it is not a comment", () => {
    expect(java('String s = "a//b";')).toBe("String s = ######;");
  });

  it("masks a char literal", () => {
    expect(java("int c = 'a';")).toBe("int c = ###;");
  });

  it("does not close a string on an escaped quote", () => {
    expect(java('String s = "a\\"b"; int ping();')).toBe("String s = ######; int ping();");
  });

  it("masks a block comment", () => {
    expect(java("/* block */ code")).toBe(`${"#".repeat(11)} code`);
  });

  it("runs an unterminated block comment to the end of the file", () => {
    expect(java("/* unterminated")).toBe("#".repeat(15));
  });

  it("keeps newlines inside a text block visible", () => {
    expect(java('"""\ntext block\n""" x')).toBe(`###\n${"#".repeat(10)}\n### x`);
  });

  it("masks a quoted annotation value but keeps the code around it", () => {
    const text = 'call("a /* not a comment */");';
    const out = java(text);
    expect(out.startsWith("call(")).toBe(true);
    expect(out.endsWith(");")).toBe(true);
    expect(out.slice(5, -2)).toBe("#".repeat(text.length - 7));
  });
});

describe("scanXml", () => {
  it("masks a comment that mentions a tag", () => {
    const text = '<!-- <select id="x"></select> -->';
    expect(xml(text)).toBe("#".repeat(text.length));
  });

  it("masks CDATA including its angle brackets", () => {
    const text = "<![CDATA[ a > b ]]>";
    expect(xml(text)).toBe("#".repeat(text.length));
  });

  it("masks a quoted attribute value, so its > cannot close the tag early", () => {
    expect(xml('<select id="a>b">')).toBe("<select id=#####>");
  });

  it("leaves apostrophes in the SQL body alone", () => {
    // A `don't` in the body must not swallow the rest of the line: the close
    // tag still has to be visible to the scanner.
    expect(xml('<select id="a">SELECT 1 -- don\'t\n</select>')).toBe("<select id=###>SELECT 1 -- don't\n</select>");
  });

  it("masks attributes of a tag that spans several lines", () => {
    expect(xml('<select id="a"\n  resultType="B">')).toBe("<select id=###\n  resultType=###>");
  });
});

describe("lineAt", () => {
  it("counts the breaks before the offset", () => {
    const text = "a\nbb\nccc";
    expect(lineAt(text, 0)).toBe(0);
    expect(lineAt(text, 2)).toBe(1);
    expect(lineAt(text, 6)).toBe(2);
  });

  it("counts the column from the start of its line", () => {
    const text = "a\nbb\nccc";
    expect(colAt(text, 0)).toBe(0);
    expect(colAt(text, 2)).toBe(0);
    expect(colAt(text, 4)).toBe(2);
    expect(colAt(text, 6)).toBe(1);
    expect(colAt(text, text.length)).toBe(3);
  });
});
