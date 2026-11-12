import { describe, expect, it } from "vitest";
import { findColors, formatColor, fromHex, parseComputed, toHex6, toHex8, type ColorMatch } from "./colors";

const NAMES = new Set(["red", "rebeccapurple", "white"]);
const isName = (w: string) => NAMES.has(w.toLowerCase());
const texts = (line: string, language: string) => findColors(line, language, isName).map((c) => c.text);

describe("findColors", () => {
  it("finds every format in style sheets", () => {
    expect(texts("  background-color: #1b766c;", "css")).toEqual(["#1b766c"]);
    expect(texts("  border: 1px solid #FFF8;", "scss")).toEqual(["#FFF8"]);
    expect(texts("  color: rgba(0, 0, 0, .5); fill: hsl(210deg 40% 50% / 0.3);", "css")).toEqual([
      "rgba(0, 0, 0, .5)",
      "hsl(210deg 40% 50% / 0.3)",
    ]);
    expect(texts("  color: red; outline: 2px solid RebeccaPurple;", "less")).toEqual(["red", "RebeccaPurple"]);
    expect(findColors("a { color: #abc }", "css", isName)[0]).toMatchObject({ from: 11, to: 15, format: "hex" });
  });

  it("skips names that are no property value, keywords and non-colors", () => {
    expect(texts(".red, #main { white-space: nowrap; color: inherit }", "css")).toEqual([]);
    expect(texts("@media screen { }", "css")).toEqual([]);
    expect(texts("  color: $white; background: var(--off-white) off-white;", "scss")).toEqual([]);
    expect(texts("  color: #12345;", "css")).toEqual([]);
  });

  it("takes only quoted hex values in code, and no names", () => {
    expect(texts(`const accent = "#1b766c"; // see #123 and #add`, "typescript")).toEqual(["#1b766c"]);
    expect(texts("color = 'rgb(255, 0, 0)'  # red", "python")).toEqual(["rgb(255, 0, 0)"]);
    expect(texts('<div style="color: #fff">', "html")).toEqual(["#fff"]);
  });

  it("leaves prose alone", () => {
    expect(texts("Fixed in #123, color `#fff`", "markdown")).toEqual([]);
  });
});

describe("formatColor", () => {
  const match = (text: string, format: ColorMatch["format"]): ColorMatch => ({
    from: 0,
    to: text.length,
    text,
    format,
  });

  it("keeps hex case, length and alpha", () => {
    expect(formatColor([255, 0, 0, 1], match("#abc", "hex"))).toBe("#f00");
    expect(formatColor([18, 52, 86, 1], match("#ABC", "hex"))).toBe("#123456");
    expect(formatColor([18, 52, 86, 1], match("#1B766C", "hex"))).toBe("#123456".toUpperCase());
    expect(formatColor([18, 52, 86, 0.5], match("#1b766c80", "hex"))).toBe("#12345680");
    expect(formatColor([18, 52, 86, 1], match("red", "name"))).toBe("#123456");
  });

  it("keeps a function's name and separators", () => {
    expect(formatColor([1, 2, 3, 1], match("rgb(0, 0, 0)", "rgb"))).toBe("rgb(1, 2, 3)");
    expect(formatColor([1, 2, 3, 0.5], match("rgba(0, 0, 0, .5)", "rgb"))).toBe("rgba(1, 2, 3, 0.5)");
    expect(formatColor([1, 2, 3, 1], match("rgb(0 0 0 / 50%)", "rgb"))).toBe("rgb(1 2 3 / 1)");
    expect(formatColor([255, 0, 0, 1], match("hsl(0, 0%, 0%)", "hsl"))).toBe("hsl(0, 100%, 50%)");
  });
});

describe("conversions", () => {
  it("round-trips opaque and alpha hex and reads computed colors", () => {
    expect(toHex6([27, 118, 108, 1])).toBe("#1b766c");
    expect(toHex8([27, 118, 108, 0.5])).toBe("#1b766c80");
    expect(fromHex("#1b766c")).toEqual([27, 118, 108, 1]);
    expect(fromHex("1B766C80")).toEqual([27, 118, 108, 128 / 255]);
    expect(fromHex("#1b766c8")).toBeNull();
    expect(fromHex("#gg766c80")).toBeNull();
    expect(parseComputed("rgb(27, 118, 108)")).toEqual([27, 118, 108, 1]);
    expect(parseComputed("rgba(0, 0, 0, 0.25)")).toEqual([0, 0, 0, 0.25]);
    expect(parseComputed("color(display-p3 1 0 0)")).toBeNull();
  });
});
