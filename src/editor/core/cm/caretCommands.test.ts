import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { indentService, type LanguageSupport } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { addCursorAbove, insertBlankLine, selectLine, toggleTabFocusMode } from "@codemirror/commands";
import {
  codeBlockEnd,
  codeBlockStart,
  cursorPageBottom,
  cursorPageTop,
  scrollDown,
  scrollUp,
  selectPageBottom,
  selectPageTop,
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

describe("editor base keymap", () => {
  it("drops CodeMirror defaults that IDEA uses for other actions", () => {
    const runs = editorBaseKeymap.map((b) => b.run);
    for (const cmd of [insertBlankLine, toggleTabFocusMode, selectLine, addCursorAbove])
      expect(runs).not.toContain(cmd);
    expect(editorBaseKeymap.some((b) => b.key === "Mod-Enter" || b.key === "Ctrl-m")).toBe(false);
    expect(editorBaseKeymap.some((b) => b.win === "Ctrl-Shift-z")).toBe(true);
  });
});
