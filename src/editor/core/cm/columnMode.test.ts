// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { columnModeExtension, extendBlock, isColumnMode, rectangleRanges, toggleColumnMode } from "./columnMode";

let view: EditorView | null = null;
afterEach(() => {
  view?.destroy();
  view = null;
});

function make(doc: string, at: number) {
  view = new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor: at },
      extensions: [columnModeExtension, EditorState.allowMultipleSelections.of(true)],
    }),
    parent: document.body,
  });
  return view;
}

const ranges = (v: EditorView) => v.state.selection.ranges.map((r) => [r.anchor, r.head]);

describe("Column Selection Mode", () => {
  it("toggles per editor", () => {
    const v = make("abc", 0);
    expect(isColumnMode(v.state)).toBe(false);
    toggleColumnMode(v);
    expect(isColumnMode(v.state)).toBe(true);
    expect(v.dom.classList.contains("cm-openidea-columnMode")).toBe(true);
    toggleColumnMode(v);
    expect(isColumnMode(v.state)).toBe(false);
  });

  it("⇧+arrows are left alone while the mode is off", () => {
    const v = make("abcd\nefgh", 1);
    expect(extendBlock(v, 1, 0)).toBe(false);
  });

  it("⇧↓ / ⇧→ build a block selection, clamped to short lines", () => {
    const v = make("abcd\nef\nijkl", 1);
    toggleColumnMode(v);
    extendBlock(v, 1, 0);
    extendBlock(v, 1, 0);
    extendBlock(v, 0, 1);
    extendBlock(v, 0, 1);
    // Lines start at 0, 5, 8; columns 1..3.
    expect(ranges(v)).toEqual([
      [1, 3],
      [6, 7],
      [9, 11],
    ]);
    extendBlock(v, -1, 0);
    expect(ranges(v)).toEqual([
      [1, 3],
      [6, 7],
    ]);
  });
});

describe("block selection in visible columns", () => {
  // `张三` takes four columns, so `//` starts at column 15 on both lines.
  const doc = 'name = "张三"  // 中文注释\nid = 42        // answer';
  const [first, second] = doc.split("\n") as [string, string];
  const from2 = first.length + 1;

  it("⇧↓ / ⇧→ keep the block on the same columns across CJK text", () => {
    const v = make(doc, first.indexOf("//"));
    toggleColumnMode(v);
    extendBlock(v, 1, 0);
    extendBlock(v, 0, 1);
    extendBlock(v, 0, 1);
    expect(ranges(v)).toEqual([
      [first.indexOf("//"), first.indexOf("//") + 2],
      [from2 + second.indexOf("//"), from2 + second.indexOf("//") + 2],
    ]);
  });

  it("⇧→ steps over a wide character as one unit", () => {
    const v = make("张三四\nabcdef", 0);
    toggleColumnMode(v);
    extendBlock(v, 0, 1);
    extendBlock(v, 1, 0);
    // One ideograph on line 1 is two letters on line 2.
    expect(ranges(v)).toEqual([
      [0, 1],
      [4, 6],
    ]);
  });

  it("mouse rectangles map visible columns back to UTF-16 offsets per line", () => {
    const v = make(`${doc}\n😀😀ab`, 0);
    const line3 = v.state.doc.line(3);
    const got = rectangleRanges(v.state, { line: 1, col: 15 }, { line: 3, col: 17 }).map((r) => [r.from, r.to]);
    expect(got).toEqual([
      [first.indexOf("//"), first.indexOf("//") + 2],
      [from2 + second.indexOf("//"), from2 + second.indexOf("//") + 2],
      // Line 3 is six columns wide, left of the block: a caret at its end.
      [line3.to, line3.to],
    ]);
    // Columns 2..6 of "😀😀ab": the second emoji (code units 2..4) and "ab".
    const inner = rectangleRanges(v.state, { line: 3, col: 2 }, { line: 3, col: 6 });
    expect(inner.map((r) => [r.from, r.to])).toEqual([[line3.from + 2, line3.from + 6]]);
  });
});
