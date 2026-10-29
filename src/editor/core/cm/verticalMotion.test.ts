// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
  cloneCaretAbove,
  cloneCaretBelow,
  cursorLineDown,
  cursorLineUp,
  selectLineDown,
  visibleGoalColumns,
} from "./verticalMotion";

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
      extensions: [visibleGoalColumns, EditorState.allowMultipleSelections.of(true), EditorState.tabSize.of(4)],
    }),
    parent: document.body,
  });
  return view;
}

const heads = (v: EditorView) => v.state.selection.ranges.map((r) => r.head);
/** Offset of `needle` on line `n` (1-based) of the view's document. */
const at = (v: EditorView, n: number, needle: string) =>
  v.state.doc.line(n).from + v.state.doc.line(n).text.indexOf(needle);

// Every `|` sits at visible column 15.
const DOC = [
  'name = "张三"  |/ 中文注释',
  "id = 42        |/ answer",
  "，。！：（）。 |/ 标点",
  "😀😀 a\t       |/ emoji",
].join("\n");

describe("vertical caret motion in visible columns", () => {
  it("↓ keeps the column through CJK, fullwidth punctuation, emoji and tabs", () => {
    const v = make(DOC, DOC.indexOf("|"));
    for (let n = 2; n <= 4; n++) {
      cursorLineDown(v);
      expect(heads(v)).toEqual([at(v, n, "|")]);
    }
    for (let n = 3; n >= 1; n--) {
      cursorLineUp(v);
      expect(heads(v)).toEqual([at(v, n, "|")]);
    }
  });

  it("keeps the goal column across a short line", () => {
    const v = make("abcdefgh\n张\nabcdefgh", 6);
    cursorLineDown(v);
    expect(heads(v)).toEqual([10]); // end of "张"
    cursorLineDown(v);
    expect(heads(v)).toEqual([11 + 6]);
  });

  it("snaps inside a wide character to the nearer side", () => {
    // Column 3 is the middle of 中 (columns 2..4) on line 2: the tie goes after it.
    const v = make("abcd\n张中", 3);
    cursorLineDown(v);
    expect(heads(v)).toEqual([5 + 2]);
  });

  it("⇧↓ extends to the same column", () => {
    const v = make("张三ab\nabcdef", 2);
    selectLineDown(v);
    expect(v.state.selection.main.anchor).toBe(2);
    expect(v.state.selection.main.head).toBe(5 + 4);
  });

  it("moves to the line boundary on the first / last line", () => {
    const v = make("ab\ncd", 1);
    cursorLineUp(v);
    expect(heads(v)).toEqual([0]);
  });
});

describe("Clone Caret Above / Below in visible columns", () => {
  it("clones at the same visible column on mixed CJK / ASCII lines", () => {
    const v = make(DOC, DOC.indexOf("|"));
    cloneCaretBelow(v);
    cloneCaretBelow(v);
    cloneCaretBelow(v);
    expect(heads(v)).toEqual([1, 2, 3, 4].map((n) => at(v, n, "|")));
  });

  it("keeps the original column past a short line", () => {
    const v = make("abcdefgh\nab\nabcdefgh", 18);
    // Caret at column 6 of line 3; line 2 is two columns wide.
    cloneCaretAbove(v);
    cloneCaretAbove(v);
    expect(heads(v)).toEqual([6, 11, 18]);
  });

  it("does nothing at the document edge", () => {
    const v = make("张三", 1);
    expect(cloneCaretAbove(v)).toBe(false);
  });
});
