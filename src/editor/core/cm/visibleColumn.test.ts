import { describe, expect, it } from "vitest";
import { findClusterBreak } from "@codemirror/state";
import {
  clusterWidth,
  codePointWidth,
  offsetAtVisibleColumn,
  stepVisibleColumn,
  visibleColumn,
  visibleWidth,
} from "./visibleColumn";

const WIDTHS: [label: string, text: string, width: number][] = [
  ["ASCII", "id = 42", 7],
  ["CJK ideographs", "张三", 4],
  ["mixed line", 'name = "张三"  // 中文注释', 26],
  ["fullwidth punctuation", "，。！：（）", 12],
  ["ideographic space", "a　b", 4],
  ["fullwidth Latin", "ＡＢ１", 6],
  ["halfwidth katakana", "ｱｲ", 2],
  ["hiragana / katakana", "かなカナ", 8],
  ["Hangul", "한글", 4],
  ["CJK Ext B", "𠀀", 2],
  ["emoji", "😀", 2],
  ["emoji ZWJ sequence", "👨‍👩‍👧", 2],
  ["emoji with skin tone", "👍🏽", 2],
  ["flag", "🇨🇳", 2],
  ["text-style pictograph", "❤", 1],
  ["pictograph + VS16", "❤️", 2],
  ["combining acute", "é", 1],
  ["several combining marks", "à̖b", 2],
  ["zero-width space", "a​b", 2],
  ["ambiguous arrow", "→", 1],
  ["tab", "\t", 4],
  ["tab after ASCII", "a\tb", 5],
  ["tab after CJK", "张\tb", 5],
  ["tab after 4 columns of CJK", "张三\tb", 9],
  ["empty", "", 0],
];

describe("visible columns", () => {
  it.each(WIDTHS)("%s", (_label, text, width) => {
    expect(visibleWidth(text, 4)).toBe(width);
  });

  it.each(WIDTHS)("round-trips every cluster boundary: %s", (_label, text) => {
    for (let i = 0; ; i = findClusterBreak(text, i)) {
      const col = visibleColumn(text, i, 4);
      const back = offsetAtVisibleColumn(text, col, 4);
      // A zero-width cluster shares its column with the boundary before it.
      if (clusterWidth(text, back, i) === 0) expect(back).toBeLessThanOrEqual(i);
      else expect(back).toBe(i);
      if (i >= text.length) break;
    }
  });

  it("code points", () => {
    expect(codePointWidth(0x41)).toBe(1);
    expect(codePointWidth(0x4e2d)).toBe(2);
    expect(codePointWidth(0xff0c)).toBe(2);
    expect(codePointWidth(0x0301)).toBe(0);
    expect(codePointWidth(0x200d)).toBe(0);
    expect(codePointWidth(0x1f600)).toBe(2);
    expect(clusterWidth("é")).toBe(1);
  });

  it("maps a column inside a wide character to the nearer side", () => {
    // "a张b": a [0,1) 张 [1,3) b [3,4); UTF-16 offsets 0, 1, 2, 3.
    const t = "a张b";
    expect([0, 1, 2, 3, 4].map((c) => offsetAtVisibleColumn(t, c, 4))).toEqual([0, 1, 2, 2, 3]);
    expect(offsetAtVisibleColumn(t, 2, 4, "before")).toBe(1);
    expect(offsetAtVisibleColumn(t, 2, 4, "after")).toBe(2);
    expect(offsetAtVisibleColumn(t, 9, 4)).toBe(3);
    expect(offsetAtVisibleColumn(t, 9, 4, "nearest", true)).toBe(-1);
  });

  it("returns UTF-16 offsets around astral characters", () => {
    // "a😀b": the emoji is two code units and two columns.
    expect(offsetAtVisibleColumn("a😀b", 3, 4)).toBe(3);
    expect(visibleColumn("a😀b", 3, 4)).toBe(3);
    expect(offsetAtVisibleColumn("a👨‍👩‍👧b", 3, 4)).toBe(1 + "👨‍👩‍👧".length);
  });

  it("steps one cluster at a time, then one column past the end", () => {
    const t = "a张\tb";
    // Columns: a 0, 张 1..3, tab 3..4, b 4..5.
    expect(stepVisibleColumn(t, 0, 1, 4)).toBe(1);
    expect(stepVisibleColumn(t, 1, 1, 4)).toBe(3);
    expect(stepVisibleColumn(t, 3, 1, 4)).toBe(4);
    expect(stepVisibleColumn(t, 5, 1, 4)).toBe(6);
    expect(stepVisibleColumn(t, 6, -1, 4)).toBe(5);
    expect(stepVisibleColumn(t, 3, -1, 4)).toBe(1);
    expect(stepVisibleColumn(t, 2, -1, 4)).toBe(1);
    expect(stepVisibleColumn(t, 1, -1, 4)).toBe(0);
  });
});
