import { describe, expect, it } from "vitest";
import { caretFromDom, caretKey, domFromCaret, moveCaret, type CaretRows } from "./consoleCaret";

const key = (k: string, mods: Partial<Record<"shiftKey" | "altKey" | "ctrlKey" | "metaKey", boolean>> = {}) => ({
  key: k,
  shiftKey: false,
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  ...mods,
});

const rowsOf = (...texts: string[]): CaretRows => ({ count: texts.length, text: (i) => texts[i] ?? "" });

describe("caret keys", () => {
  it("maps IDEA's console navigation on Windows / Linux", () => {
    expect(caretKey(key("Home"), false)).toEqual({ move: "lineStart", extend: false });
    expect(caretKey(key("End", { shiftKey: true }), false)).toEqual({ move: "lineEnd", extend: true });
    expect(caretKey(key("Home", { ctrlKey: true }), false)).toEqual({ move: "textStart", extend: false });
    expect(caretKey(key("End", { ctrlKey: true, shiftKey: true }), false)).toEqual({ move: "textEnd", extend: true });
    expect(caretKey(key("PageDown"), false)).toEqual({ move: "pageDown", extend: false });
    expect(caretKey(key("ArrowUp", { shiftKey: true }), false)).toEqual({ move: "up", extend: true });
  });

  it("uses ⌘ on macOS, where ⌘← / ⌘→ also go to the line's start / end", () => {
    expect(caretKey(key("Home", { metaKey: true }), true)).toEqual({ move: "textStart", extend: false });
    expect(caretKey(key("ArrowLeft", { metaKey: true }), true)).toEqual({ move: "lineStart", extend: false });
    expect(caretKey(key("ArrowRight", { metaKey: true, shiftKey: true }), true)).toEqual({
      move: "lineEnd",
      extend: true,
    });
    expect(caretKey(key("Home", { ctrlKey: true }), true)).toBeNull();
  });

  it("leaves keystrokes the keymap owns alone", () => {
    // ⌃PageUp / ⌃PageDown (Move Caret to Page Top / Bottom, tab switching), word moves, Alt+Home.
    expect(caretKey(key("PageUp", { ctrlKey: true }), false)).toBeNull();
    expect(caretKey(key("ArrowLeft", { ctrlKey: true }), false)).toBeNull();
    expect(caretKey(key("ArrowRight", { altKey: true }), true)).toBeNull();
    expect(caretKey(key("Home", { altKey: true }), false)).toBeNull();
    expect(caretKey(key("a"), false)).toBeNull();
  });
});

describe("moving the caret", () => {
  const rows = rowsOf("first line", "", "a 😀 b", "last");
  const move = (
    row: number,
    offset: number,
    m: Parameters<typeof moveCaret>[2],
    page = 2,
    goal: number | null = null,
  ) => moveCaret(rows, { row, offset }, m, page, goal);

  it("goes to the line's start and end, and the output's", () => {
    expect(move(0, 4, "lineStart").position).toEqual({ row: 0, offset: 0 });
    expect(move(0, 4, "lineEnd").position).toEqual({ row: 0, offset: 10 });
    expect(move(2, 1, "textStart").position).toEqual({ row: 0, offset: 0 });
    expect(move(0, 1, "textEnd").position).toEqual({ row: 3, offset: 4 });
  });

  it("crosses line ends sideways and steps over a surrogate pair at once", () => {
    expect(move(0, 10, "right").position).toEqual({ row: 1, offset: 0 });
    expect(move(1, 0, "left").position).toEqual({ row: 0, offset: 10 });
    expect(move(2, 2, "right").position).toEqual({ row: 2, offset: 4 });
    expect(move(2, 4, "left").position).toEqual({ row: 2, offset: 2 });
    expect(move(0, 0, "left").position).toEqual({ row: 0, offset: 0 });
    expect(move(3, 4, "right").position).toEqual({ row: 3, offset: 4 });
  });

  it("keeps the column through shorter lines going up and down", () => {
    const down = move(0, 8, "down");
    expect(down).toEqual({ position: { row: 1, offset: 0 }, goal: 8 });
    const again = move(down.position.row, down.position.offset, "down", 2, down.goal);
    expect(again.position).toEqual({ row: 2, offset: 6 });
    expect(move(2, 6, "up", 2, 8).position).toEqual({ row: 1, offset: 0 });
    expect(move(0, 3, "up").position).toEqual({ row: 0, offset: 3 });
    // A sideways move forgets it.
    expect(move(0, 3, "right", 2, 8).goal).toBeNull();
  });

  it("moves a page and stops at either end", () => {
    expect(move(0, 2, "pageDown").position).toEqual({ row: 2, offset: 2 });
    expect(move(2, 2, "pageDown", 5).position).toEqual({ row: 3, offset: 2 });
    expect(move(3, 2, "pageUp", 10).position).toEqual({ row: 0, offset: 2 });
  });
});

describe("caret positions in the DOM", () => {
  /** A row as the Run console renders it: a fold toggle, text spans, a fold placeholder, input, a break. */
  function row() {
    const el = document.createElement("div");
    el.dataset.index = "7";
    el.innerHTML =
      '<button>⌄</button><span>at </span><a>Foo.java:12</a><button> &lt;3 internal lines&gt;</button><span data-caret-skip="">typed</span>';
    el.append("\n");
    document.body.replaceChildren(el);
    return el;
  }

  it("counts only the line's text", () => {
    const el = row();
    const link = el.querySelector("a")!.firstChild!;
    expect(caretFromDom(document.body, link, 3)).toEqual({ row: 7, offset: 6 });
    expect(caretFromDom(document.body, el.lastChild!, 1)).toEqual({ row: 7, offset: 14 });
    expect(caretFromDom(document.body, el.querySelector("[data-caret-skip]")!.firstChild!, 2)).toEqual({
      row: 7,
      offset: 14,
    });
    expect(caretFromDom(document.body, el, 0)).toEqual({ row: 7, offset: 0 });
    expect(caretFromDom(document.body, document.body, 0)).toBeNull();
  });

  it("finds the text node of an offset and round-trips", () => {
    const el = row();
    for (let offset = 0; offset <= 14; offset++) {
      const point = domFromCaret(el, offset);
      expect(point.node.nodeType).toBe(Node.TEXT_NODE);
      expect(caretFromDom(document.body, point.node, point.offset)).toEqual({ row: 7, offset });
    }
    const blank = document.createElement("div");
    blank.dataset.index = "8";
    blank.append("\n");
    expect(domFromCaret(blank, 0)).toEqual({ node: blank, offset: 0 });
  });
});
