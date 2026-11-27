import { describe, expect, it } from "vitest";
import { cssColor, findColors, formatColor, fromHex, parseComputed, toHex6, toHex8, type ColorMatch } from "./colors";

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

  it("reads XAML's alpha-first hex (#AARRGGBB, #ARGB) as CSS colors", () => {
    const [wide, short, opaque] = findColors(
      '<Window Background="#FF2B5797" Fill="#8F00" Stroke="#1b766c"/>',
      "axaml",
      isName,
    );
    expect([wide!.argb, short!.argb, opaque!.argb]).toEqual([true, true, undefined]);
    expect([cssColor(wide!), cssColor(short!), cssColor(opaque!)]).toEqual(["#2B5797FF", "#F008", "#1b766c"]);
    // Elsewhere an eight-digit hex is CSS's #RRGGBBAA.
    const [css] = findColors('const c = "#FF2B5797";', "typescript", isName);
    expect([css!.argb, cssColor(css!)]).toEqual([undefined, "#FF2B5797"]);
  });

  it("reads java.awt.Color's int constructor as RGB", () => {
    const [color, ui, sevenDigits] = findColors(
      "c = new Color(0xFF00FF); d = new javax.swing.plaf.ColorUIResource( 0x0be881 ); e = new ColorUIResource(0xfffbe7c);",
      "java",
      isName,
    );
    expect([color, ui, sevenDigits].map((c) => c && [c.text, c.format, cssColor(c)])).toEqual([
      ["0xFF00FF", "int", "#ff00ff"],
      ["0x0be881", "int", "#0be881"],
      // Color(int) reads the low 24 bits.
      ["0xfffbe7c", "int", "#ffbe7c"],
    ]);
    expect(texts('new Color(0x112233); // "#fff"', "java")).toEqual(["0x112233", "#fff"]);
    // Other overloads, other literals and other classes or languages are not this constructor.
    expect(
      texts(
        "new Color(0x10, 0x20, 0x30); new Color(0x80ff0000, true); new Color(0xFF_00_FF); new Color(0xFFL); new Font(0x10); int x = 0xFF00FF; new com.badlogic.gdx.graphics.Color(0x00ff00ff);",
        "java",
      ),
    ).toEqual([]);
    expect(texts("val c = Color(0xFF00FF); new Color(0xFF00FF)", "kotlin")).toEqual([]);
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

  it("writes an alpha-first hex back with the alpha first", () => {
    const argb = (text: string): ColorMatch => ({ ...match(text, "hex"), argb: true });
    expect(formatColor([18, 52, 86, 1], argb("#FF2B5797"))).toBe("#FF123456");
    expect(formatColor([18, 52, 86, 0.5], argb("#ff2b5797"))).toBe("#80123456");
    expect(formatColor([255, 0, 0, 0.6], argb("#8F00"))).toBe("#9F00");
  });

  it("writes a Java int color back as 0x hex in its case, dropping alpha", () => {
    expect(formatColor([18, 52, 86, 1], match("0xFF00FF", "int"))).toBe("0x123456");
    expect(formatColor([171, 205, 239, 1], match("0XFF00FF", "int"))).toBe("0XABCDEF");
    expect(formatColor([171, 205, 239, 0.5], match("0xff00ff", "int"))).toBe("0xabcdef");
    // Digits above the low 24 bits are not read by Color(int) and stay as written.
    expect(formatColor([18, 52, 86, 1], match("0xfffbe7c", "int"))).toBe("0xf123456");
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
