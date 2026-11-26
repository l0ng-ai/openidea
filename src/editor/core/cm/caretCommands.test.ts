import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { EditorSelection, EditorState, StateEffect } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { codeFolding, foldEffect, indentService, type LanguageSupport } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { addCursorAbove, insertBlankLine, selectLine, toggleTabFocusMode } from "@codemirror/commands";
import {
  codeBlockEnd,
  codeBlockStart,
  cursorPageBottom,
  cursorPageTop,
  cursorParagraphBackward,
  cursorParagraphForward,
  nextParagraphBoundary,
  previousParagraphBoundary,
  scrollDown,
  scrollDownAndMove,
  scrollToBottom,
  scrollToTop,
  scrollUp,
  scrollUpAndMove,
  selectPageBottom,
  selectPageTop,
  selectParagraphForward,
  splitLine,
} from "./caretCommands";
import { editorBaseKeymap } from "./baseKeymap";

const views: EditorView[] = [];
afterEach(() => views.splice(0).forEach((v) => v.destroy()));

/** One unit deeper after a line ending in `{`. */
const braceIndent = indentService.of((cx, pos) => {
  const line = cx.lineAt(pos, -1);
  const base = /^ */.exec(line.text)![0].length;
  return line.text
    .slice(0, pos - line.from)
    .trimEnd()
    .endsWith("{")
    ? base + 2
    : base;
});

/** `|` marks carets. */
function make(text: string) {
  const carets: number[] = [];
  let doc = "";
  for (const ch of text) {
    if (ch === "|") carets.push(doc.length);
    else doc += ch;
  }
  const view = new EditorView({
    state: EditorState.create({
      doc,
      selection: EditorSelection.create(carets.map((c) => EditorSelection.cursor(c))),
      extensions: [EditorState.allowMultipleSelections.of(true), braceIndent],
    }),
  });
  views.push(view);
  return view;
}

function show(view: EditorView) {
  const doc = view.state.doc.toString();
  const heads = view.state.selection.ranges.map((r) => r.head).sort((a, b) => b - a);
  return heads.reduce((s, h) => s.slice(0, h) + "|" + s.slice(h), doc);
}

describe("Split Line", () => {
  it("breaks the line at each caret and leaves the caret before the break", () => {
    const view = make("if (a) {|return 1; }");
    splitLine(view);
    expect(show(view)).toBe("if (a) {|\n  return 1; }");
    const multi = make("a|b\nc|d");
    splitLine(multi);
    expect(show(multi)).toBe("a|\nb\nc|\nd");
  });
});

describe("Scroll Up / Scroll Down", () => {
  /** jsdom has no layout: record what the command asks the scroller for. */
  function scroller(view: EditorView, start: number) {
    let top = start;
    Object.defineProperty(view.scrollDOM, "scrollTop", {
      configurable: true,
      get: () => top,
      set: (v: number) => (top = v),
    });
    return () => top;
  }

  it("moves the viewport one line at a time", () => {
    const view = make("a\nb|\nc");
    const top = scroller(view, 100);
    const line = view.defaultLineHeight;
    expect(line).toBeGreaterThan(0);
    expect(scrollDown(view)).toBe(true);
    expect(top()).toBe(100 + line);
    expect(scrollUp(view)).toBe(true);
    expect(scrollUp(view)).toBe(true);
    expect(top()).toBe(100 - line);
  });

  it("leaves the carets and the selection where they are", () => {
    const view = make("|a\nb\nc");
    view.dispatch({ selection: EditorSelection.create([EditorSelection.range(0, 3), EditorSelection.cursor(5)], 1) });
    const before = view.state.selection;
    scroller(view, 50);
    scrollDown(view);
    scrollUp(view);
    expect(view.state.selection.eq(before)).toBe(true);
    expect(view.state.doc.toString()).toBe("a\nb\nc");
  });
});

describe("Scroll to Top / Scroll to Bottom", () => {
  /** jsdom has no layout: record where each command asks the view to scroll. */
  function scrolls(text: string) {
    const targets: { from: number; to: number; y: unknown }[] = [];
    const view = make(text);
    view.dispatch({
      effects: StateEffect.appendConfig.of(
        EditorView.scrollHandler.of(
          (_, range, options) => (targets.push({ from: range.from, to: range.to, y: options.y }), true),
        ),
      ),
    });
    return { view, targets };
  }
  /** The view scrolls in its next measure, on an animation frame. */
  const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));

  it("scrolls to the very top, keeping the horizontal position", async () => {
    const view = make("a\nb|\nc\nd");
    let top = 120;
    Object.defineProperty(view.scrollDOM, "scrollTop", {
      configurable: true,
      get: () => top,
      set: (v: number) => (top = v),
    });
    view.scrollDOM.scrollLeft = 40;
    expect(scrollToTop(view)).toBe(true);
    await frame();
    expect(top).toBe(0);
    expect(view.scrollDOM.scrollLeft).toBe(40);
  });

  it("brings the end of the file toward the middle", async () => {
    const { view, targets } = scrolls("a\nb|\nc\nd");
    expect(scrollToBottom(view)).toBe(true);
    await frame();
    expect(targets).toEqual([{ from: 7, to: 7, y: "center" }]);
  });

  it("leaves the carets, the selection and the document as they are", () => {
    const { view } = scrolls("|a\nb\nc");
    view.dispatch({ selection: EditorSelection.create([EditorSelection.range(0, 3), EditorSelection.cursor(5)], 1) });
    const before = view.state.selection;
    scrollToBottom(view);
    scrollToTop(view);
    expect(view.state.selection.eq(before)).toBe(true);
    expect(view.state.doc.toString()).toBe("a\nb\nc");
  });

  it("works in an empty file", async () => {
    const { view, targets } = scrolls("|");
    scrollToBottom(view);
    await frame();
    expect(targets).toEqual([{ from: 0, to: 0, y: "center" }]);
  });
});

describe("Move Caret to Page Top / Bottom", () => {
  /** jsdom has no layout: show the document from `top` for `height` pixels (in line heights). */
  function page(view: EditorView, top: number, height: number) {
    const line = view.lineBlockAt(0).height;
    Object.defineProperty(view, "documentTop", { configurable: true, get: () => -top * line });
    Object.defineProperty(view.scrollDOM, "clientHeight", { configurable: true, get: () => height * line });
  }
  const lines = (marked: Record<number, string>) =>
    Array.from({ length: 10 }, (_, i) => marked[i] ?? `line ${i} text`).join("\n");
  const lineOf = (view: EditorView) => view.state.selection.ranges.map((r) => view.state.doc.lineAt(r.head).number - 1);
  const columnOf = (view: EditorView) =>
    view.state.selection.ranges.map((r) => r.head - view.state.doc.lineAt(r.head).from);

  it("goes to the first and last lines shown whole, keeping the column", () => {
    const view = make(lines({ 7: "line 7 te|xt" }));
    page(view, 2, 4);
    expect(view.lineBlockAt(view.state.doc.line(10).from).top).toBe(9 * view.lineBlockAt(0).height);
    expect(cursorPageTop(view)).toBe(true);
    expect([lineOf(view), columnOf(view)]).toEqual([[2], [9]]);
    expect(cursorPageBottom(view)).toBe(true);
    expect([lineOf(view), columnOf(view)]).toEqual([[5], [9]]);
  });

  it("skips a line cut by the edge of the view", () => {
    const view = make(lines({ 0: "|line 0 text" }));
    page(view, 2.5, 4);
    cursorPageTop(view);
    expect(lineOf(view)).toEqual([3]);
    cursorPageBottom(view);
    expect(lineOf(view)).toEqual([5]);
  });

  it("stays on the only line a view lower than a line shows", () => {
    const view = make(lines({ 0: "|line 0 text" }));
    page(view, 2.5, 0.5);
    cursorPageTop(view);
    expect(lineOf(view)).toEqual([2]);
    cursorPageBottom(view);
    expect(lineOf(view)).toEqual([2]);
  });

  it("goes to the last line of a document shorter than the view", () => {
    const view = make(lines({ 4: "li|ne 4 text" }));
    page(view, 0, 40);
    cursorPageBottom(view);
    expect([lineOf(view), columnOf(view)]).toEqual([[9], [2]]);
    cursorPageTop(view);
    expect([lineOf(view), columnOf(view)]).toEqual([[0], [2]]);
  });

  it("keeps the visual column across tabs and stops at the end of a shorter line", () => {
    const view = make(lines({ 2: "ab", 5: "\tx", 8: "        long|er line" }));
    page(view, 2, 4);
    cursorPageTop(view);
    expect([lineOf(view), columnOf(view)]).toEqual([[2], [2]]);
    view.dispatch({ selection: EditorSelection.cursor(view.state.doc.line(9).from + 9) });
    cursorPageBottom(view);
    expect([lineOf(view), columnOf(view)]).toEqual([[5], [2]]);
  });

  it("moves every caret, merging the ones that land together", () => {
    const view = make(lines({ 0: "li|ne 0 text", 1: "line 1 te|xt", 8: "li|ne 8 text" }));
    page(view, 3, 3);
    cursorPageTop(view);
    expect([lineOf(view), columnOf(view)]).toEqual([
      [3, 3],
      [2, 9],
    ]);
  });

  it("extends the selection from where it started with Selection", () => {
    const view = make(lines({ 7: "line 7 |text" }));
    page(view, 2, 4);
    const anchor = view.state.selection.main.head;
    selectPageTop(view);
    expect(view.state.selection.main.anchor).toBe(anchor);
    expect([lineOf(view), columnOf(view)]).toEqual([[2], [7]]);
    selectPageBottom(view);
    expect(view.state.selection.main.anchor).toBe(anchor);
    expect([lineOf(view), columnOf(view)]).toEqual([[5], [7]]);
  });
});

describe("Scroll Up / Down and Move if Necessary", () => {
  /** jsdom has no layout: a scroller `height` line heights tall, scrolled to `top` line heights. */
  function scroller(view: EditorView, top: number, height: number) {
    const line = view.lineBlockAt(0).height;
    let px = top * line;
    Object.defineProperty(view.scrollDOM, "scrollTop", {
      configurable: true,
      get: () => px,
      set: (v: number) => (px = Math.max(0, v)),
    });
    Object.defineProperty(view, "documentTop", { configurable: true, get: () => -px });
    Object.defineProperty(view.scrollDOM, "clientHeight", { configurable: true, get: () => height * line });
    return () => px / line;
  }
  const lines = (marked: Record<number, string>) =>
    Array.from({ length: 10 }, (_, i) => marked[i] ?? `line ${i} text`).join("\n");
  const lineOf = (view: EditorView) => view.state.selection.ranges.map((r) => view.state.doc.lineAt(r.head).number - 1);
  const columnOf = (view: EditorView) =>
    view.state.selection.ranges.map((r) => r.head - view.state.doc.lineAt(r.head).from);

  it("scrolls one line and keeps a caret that stays in view where it is", () => {
    const view = make(lines({ 4: "line 4 te|xt" }));
    const top = scroller(view, 2, 4);
    const before = view.state.selection;
    expect(scrollDownAndMove(view)).toBe(true);
    expect(top()).toBe(3);
    expect(view.state.selection.eq(before)).toBe(true);
    expect(scrollUpAndMove(view)).toBe(true);
    expect(top()).toBe(2);
    expect(view.state.selection.eq(before)).toBe(true);
  });

  it("brings a caret that scrolls off the top down to the first line, keeping its column", () => {
    const view = make(lines({ 2: "line 2 te|xt" }));
    scroller(view, 2, 4);
    scrollDownAndMove(view);
    expect([lineOf(view), columnOf(view)]).toEqual([[3], [9]]);
  });

  it("brings a caret that scrolls off the bottom up to the last line, keeping its column", () => {
    const view = make(lines({ 5: "li|ne 5 text" }));
    scroller(view, 2, 4);
    scrollUpAndMove(view);
    expect([lineOf(view), columnOf(view)]).toEqual([[4], [2]]);
  });

  it("moves a caret already out of view to the nearest edge", () => {
    const view = make(lines({ 9: "line 9 |text" }));
    scroller(view, 0, 4);
    scrollDownAndMove(view);
    expect([lineOf(view), columnOf(view)]).toEqual([[4], [7]]);
  });

  it("drops the selection of a caret it moves and keeps the others", () => {
    const view = make(lines({ 0: "|line 0 text" }));
    const at = (line: number, col: number) => view.state.doc.line(line + 1).from + col;
    view.dispatch({
      selection: EditorSelection.create(
        [EditorSelection.range(at(2, 0), at(2, 4)), EditorSelection.range(at(4, 0), at(4, 4))],
        1,
      ),
    });
    scroller(view, 2, 4);
    scrollDownAndMove(view);
    expect(view.state.selection.ranges.map((r) => [r.anchor, r.head])).toEqual([
      [at(3, 4), at(3, 4)],
      [at(4, 0), at(4, 4)],
    ]);
    expect(view.state.selection.mainIndex).toBe(1);
  });

  it("keeps a caret at the end of a folded block the view shows", () => {
    const view = make(lines({ 7: "line 7 text|" }));
    const { doc } = view.state;
    view.dispatch({
      effects: [
        StateEffect.appendConfig.of(codeFolding()),
        foldEffect.of({ from: doc.line(6).to, to: doc.line(8).to }),
      ],
    });
    expect(view.lineBlockAt(doc.line(8).to).from).toBe(doc.line(6).from);
    const before = view.state.selection;
    scroller(view, 1, 4);
    scrollDownAndMove(view);
    expect(view.state.selection.eq(before)).toBe(true);
  });

  it("only scrolls at the top of the file when the caret stays in view", () => {
    const view = make(lines({ 1: "|line 1 text" }));
    const top = scroller(view, 0, 4);
    const before = view.state.selection;
    scrollUpAndMove(view);
    expect(top()).toBe(0);
    expect(view.state.selection.eq(before)).toBe(true);
    expect(view.state.doc.toString()).toBe(lines({}));
  });
});

describe("code block navigation", () => {
  let js: LanguageSupport;
  beforeAll(async () => {
    js = await languages.find((l) => l.name === "JavaScript")!.load();
  });
  const at = (text: string) => {
    const pos = text.indexOf("|");
    return { state: EditorState.create({ doc: text.replace("|", ""), extensions: js }), pos };
  };

  it("goes to just inside the enclosing braces", () => {
    const { state, pos } = at("f() { if (x) { a|(); } b(); }");
    expect(codeBlockStart(state, pos)).toBe("f() { if (x) {".length);
    expect(codeBlockEnd(state, pos)).toBe("f() { if (x) { a(); ".length);
  });

  it("jumps across a brace at the caret to its match, and outward from inside one", () => {
    const text = "f() { if (x) { a(); } b(); }";
    const { state } = at(text);
    const open = text.indexOf("{", 6);
    const close = text.indexOf("}");
    expect(codeBlockEnd(state, open)).toBe(close + 1); // |{ … } → { … }|
    expect(codeBlockStart(state, close + 1)).toBe(open); // { … }| → |{ … }
    expect(codeBlockStart(state, open + 1)).toBe(text.indexOf("{") + 1); // {| → outer block
    expect(codeBlockEnd(state, close)).toBe(text.lastIndexOf("}")); // |} → outer block
  });

  it("skips braces in strings and comments", () => {
    const { state, pos } = at('f() { const s = "{"; /* } */ a|(); }');
    expect(codeBlockStart(state, pos)).toBe("f() {".length);
    expect(codeBlockEnd(state, pos)).toBe('f() { const s = "{"; /* } */ a(); '.length);
  });

  it("has nowhere to go outside any block", () => {
    const { state, pos } = at("a|();");
    expect(codeBlockStart(state, pos)).toBeNull();
    expect(codeBlockEnd(state, pos)).toBeNull();
  });
});

describe("paragraph navigation", () => {
  // Lines: "a1", "a2", "", "b1", "b2", "  ", "c1", "c2".
  const text = "a1\na2\n\nb1\nb2\n  \nc1\nc2";
  const state = EditorState.create({ doc: text });
  const empty = text.indexOf("\n\n") + 1;
  const spaces = text.indexOf("  ");
  const c1 = text.indexOf("c1");
  const at = (s: string) => text.indexOf(s);

  it("goes forward to the next blank line, whitespace-only included, or the end of the text", () => {
    expect(nextParagraphBoundary(state, 0)).toBe(empty);
    expect(nextParagraphBoundary(state, at("a2") + 1)).toBe(empty);
    expect(nextParagraphBoundary(state, at("b1") + 1)).toBe(spaces);
    // From a blank line: past it and the paragraph after it.
    expect(nextParagraphBoundary(state, empty)).toBe(spaces);
    expect(nextParagraphBoundary(state, spaces + 1)).toBe(text.length);
    expect(nextParagraphBoundary(state, at("c2"))).toBe(text.length);
  });

  it("goes backward to the empty line before the paragraph, or the line after a whitespace-only one", () => {
    expect(previousParagraphBoundary(state, at("c2") + 1)).toBe(c1);
    expect(previousParagraphBoundary(state, at("b2") + 2)).toBe(empty);
    expect(previousParagraphBoundary(state, at("a2") + 1)).toBe(0);
    expect(previousParagraphBoundary(state, 0)).toBe(0);
  });

  it("goes backward past the paragraph above from a line start or a blank line", () => {
    expect(previousParagraphBoundary(state, c1)).toBe(empty);
    expect(previousParagraphBoundary(state, spaces + 2)).toBe(empty);
    expect(previousParagraphBoundary(state, at("b1"))).toBe(0);
    expect(previousParagraphBoundary(state, empty)).toBe(0);
  });

  it("does not stall on a whitespace-only line when pressed repeatedly", () => {
    const stops: number[] = [];
    let pos = text.length;
    while (pos > 0) stops.push((pos = previousParagraphBoundary(state, pos)));
    expect(stops).toEqual([c1, empty, 0]);
    stops.length = 0;
    while (pos < text.length) stops.push((pos = nextParagraphBoundary(state, pos)));
    expect(stops).toEqual([empty, spaces, text.length]);
  });

  it("treats a document with no blank line as one paragraph", () => {
    const one = EditorState.create({ doc: "x\ny" });
    expect(nextParagraphBoundary(one, 0)).toBe(3);
    expect(previousParagraphBoundary(one, 3)).toBe(0);
    const blank = EditorState.create({ doc: "" });
    expect(nextParagraphBoundary(blank, 0)).toBe(0);
    expect(previousParagraphBoundary(blank, 0)).toBe(0);
  });

  it("moves every caret, merging carets that land together", () => {
    const view = make("a|1\na|2\n\nb|1\nb2");
    expect(cursorParagraphForward(view)).toBe(true);
    expect(show(view)).toBe("a1\na2\n|\nb1\nb2|");
    expect(cursorParagraphBackward(view)).toBe(true);
    expect(show(view)).toBe("|a1\na2\n|\nb1\nb2");
  });

  it("with Selection extends each selection from its anchor", () => {
    const view = make("a1\na|2\n\nb1");
    selectParagraphForward(view);
    expect(view.state.selection.main).toMatchObject({ anchor: 4, head: 6 });
    selectParagraphForward(view);
    expect(view.state.selection.main).toMatchObject({ anchor: 4, head: 9 });
  });
});

describe("editor base keymap", () => {
  it("drops CodeMirror defaults that IDEA uses for other actions", () => {
    const runs = editorBaseKeymap.map((b) => b.run);
    for (const cmd of [insertBlankLine, toggleTabFocusMode, selectLine, addCursorAbove])
      expect(runs).not.toContain(cmd);
    expect(editorBaseKeymap.some((b) => b.key === "Mod-Enter" || b.key === "Ctrl-m")).toBe(false);
    expect(editorBaseKeymap.some((b) => b.win === "Ctrl-Shift-z")).toBe(true);
  });
});
