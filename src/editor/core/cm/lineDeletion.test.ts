import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { writeClipboardText } from "@/platform/clipboard";
import { clearClipboardHistory, clipboardHistory, recordClipboard } from "../clipboardHistory";
import {
  cutToLineEnd,
  deleteToLogicalLineEnd,
  deleteToLogicalLineStart,
  hungryBackspace,
  killToWordEnd,
  killToWordStart,
} from "./lineDeletion";

vi.mock("@/platform/clipboard", () => ({ writeClipboardText: vi.fn(async () => {}) }));

const views: EditorView[] = [];
afterEach(() => {
  views.splice(0).forEach((v) => v.destroy());
  clearClipboardHistory();
  vi.mocked(writeClipboardText).mockClear();
});

/** `|` marks carets, `[`/`]` a selection (its head at `]`). */
function make(text: string, readOnly = false) {
  const ranges: ReturnType<typeof EditorSelection.cursor>[] = [];
  let doc = "";
  let anchor = -1;
  for (const ch of text) {
    if (ch === "|") ranges.push(EditorSelection.cursor(doc.length));
    else if (ch === "[") anchor = doc.length;
    else if (ch === "]") ranges.push(EditorSelection.range(anchor, doc.length));
    else doc += ch;
  }
  const view = new EditorView({
    state: EditorState.create({
      doc,
      selection: EditorSelection.create(ranges),
      extensions: [EditorState.allowMultipleSelections.of(true), EditorState.readOnly.of(readOnly)],
    }),
    parent: document.body,
  });
  views.push(view);
  return view;
}

function show(view: EditorView): string {
  const { doc, selection } = view.state;
  let out = doc.toString();
  for (const r of [...selection.ranges].sort((a, b) => b.from - a.from))
    out = r.empty
      ? out.slice(0, r.head) + "|" + out.slice(r.head)
      : out.slice(0, r.from) + "[" + out.slice(r.from, r.to) + "]" + out.slice(r.to);
  return out;
}

const run = (command: (v: EditorView) => boolean, text: string) => {
  const v = make(text);
  command(v);
  return show(v);
};

describe("Delete to Line End", () => {
  it.each([
    ["the rest of the line", "ab|cd\nef", "ab|\nef"],
    ["the line break at the line end", "ab|\nef", "ab|ef"],
    ["blank rest and its line break", "ab|  \nef", "ab|ef"],
    ["blank rest of the last line", "ab|  ", "ab|"],
    ["nothing at the end of the text", "ab\nef|", "ab\nef|"],
    ["a selection as it is", "a[bc]d\nef", "a|d\nef"],
    ["from every caret, overlaps merged", "a|b|c\nd|e", "a|\nd|"],
    ["the document line, past a blank middle line", "x|\n\ny", "x|\ny"],
  ])("deletes %s", (_, text, expected) => {
    expect(run(deleteToLogicalLineEnd, text)).toBe(expected);
  });

  it("does nothing in a read-only editor", () => {
    const v = make("ab|cd", true);
    expect(deleteToLogicalLineEnd(v)).toBe(false);
    expect(show(v)).toBe("ab|cd");
  });
});

describe("Delete to Line Start", () => {
  it.each([
    ["the line up to the caret", "xy\nab|cd", "xy\n|cd"],
    ["the line break at the line start", "ab\n|cd", "ab|cd"],
    ["nothing at the start of the text", "|ab", "|ab"],
    ["a selection as it is", "a[bc]d", "a|d"],
    ["from every caret", "ab|c\nde|f", "|c\n|f"],
  ])("deletes %s", (_, text, expected) => {
    expect(run(deleteToLogicalLineStart, text)).toBe(expected);
  });

  it("does nothing in a read-only editor", () => {
    const v = make("ab|cd", true);
    expect(deleteToLogicalLineStart(v)).toBe(false);
    expect(show(v)).toBe("ab|cd");
  });
});

describe("Cut up to Line End", () => {
  it("cuts to the line end into the clipboard and Paste from History", () => {
    const v = make("a|bc\nd");
    expect(cutToLineEnd(v)).toBe(true);
    expect(show(v)).toBe("a|\nd");
    expect(writeClipboardText).toHaveBeenLastCalledWith("bc");
    expect(clipboardHistory().map((e) => e.text)).toEqual(["bc"]);
  });

  it("collects repeated cuts at the same caret into one entry", () => {
    const v = make("a|bc\nd\ne");
    cutToLineEnd(v);
    cutToLineEnd(v);
    cutToLineEnd(v);
    expect(show(v)).toBe("a|\ne");
    expect(writeClipboardText).toHaveBeenLastCalledWith("bc\nd");
    expect(clipboardHistory().map((e) => e.text)).toEqual(["bc\nd"]);
  });

  it("starts a new entry after an edit, a caret move or another copy", () => {
    const edited = make("a|b\nc");
    cutToLineEnd(edited);
    edited.dispatch(edited.state.replaceSelection("x"));
    cutToLineEnd(edited);
    expect(show(edited)).toBe("ax|c");
    expect(clipboardHistory().map((e) => e.text)).toEqual(["\n", "b"]);

    clearClipboardHistory();
    const moved = make("a|b\ncd");
    cutToLineEnd(moved);
    moved.dispatch({ selection: { anchor: 3 } });
    cutToLineEnd(moved);
    expect(show(moved)).toBe("a\nc|");
    expect(clipboardHistory().map((e) => e.text)).toEqual(["d", "b"]);

    clearClipboardHistory();
    const copied = make("a|b\nc");
    cutToLineEnd(copied);
    recordClipboard("other");
    cutToLineEnd(copied);
    expect(clipboardHistory().map((e) => e.text)).toEqual(["\n", "other", "b"]);
  });

  it("cuts from the caret, not the selection", () => {
    expect(run(cutToLineEnd, "x[ab]cd\ne")).toBe("xab|\ne");
    expect(writeClipboardText).toHaveBeenLastCalledWith("cd");
  });

  it("cuts from every caret into one entry, without collecting the next cut", () => {
    const v = make("a|b\nc|d\ne");
    cutToLineEnd(v);
    expect(show(v)).toBe("a|\nc|\ne");
    expect(writeClipboardText).toHaveBeenLastCalledWith("b\nd");
    cutToLineEnd(v);
    expect(show(v)).toBe("a|c|e");
    expect(clipboardHistory().map((e) => e.text)).toEqual(["\n\n\n", "b\nd"]);
  });

  it("skips carets with nothing to cut, and collects only after a single caret", () => {
    const v = make("a|b\nc|");
    cutToLineEnd(v);
    expect(show(v)).toBe("a|\nc|");
    expect(writeClipboardText).toHaveBeenLastCalledWith("b");

    const sameLine = make("a|b|c\nd");
    cutToLineEnd(sameLine);
    cutToLineEnd(sameLine);
    expect(show(sameLine)).toBe("a|d");
    expect(clipboardHistory().map((e) => e.text)).toEqual(["\n", "bc", "b"]);
  });

  it("leaves the clipboard alone with nothing to cut or in a read-only editor", () => {
    expect(run(cutToLineEnd, "ab|")).toBe("ab|");
    const v = make("a|b", true);
    expect(cutToLineEnd(v)).toBe(false);
    expect(show(v)).toBe("a|b");
    expect(writeClipboardText).not.toHaveBeenCalled();
    expect(clipboardHistory()).toEqual([]);
  });
});

describe("Kill to Word Start / End", () => {
  it.each([
    ["the word before the caret", "foo bar|", false, "foo |", "bar"],
    ["the rest of the word", "foo ba|r", false, "foo |r", "ba"],
    ["whitespace and the word before it", "foo  |bar", false, "|bar", "foo  "],
    ["across line breaks and blank lines", "foo\n  \n|bar", false, "|bar", "foo\n  \n"],
    ["a punctuation run", "a.b?.|c", false, "a.b|c", "?."],
    ["the whole identifier without CamelHumps", "x fooBar|", false, "x |", "fooBar"],
    ["one hump with CamelHumps", "x fooBar|", true, "x foo|", "Bar"],
    ["a snake_case hump with CamelHumps", "x foo_bar|", true, "x foo_|", "bar"],
  ])("Kill to Word Start cuts %s", (_, text, camelHumps, after, cut) => {
    expect(run(killToWordStart(camelHumps), text)).toBe(after);
    expect(writeClipboardText).toHaveBeenLastCalledWith(cut);
  });

  it.each([
    ["the word after the caret", "|foo bar", false, "| bar", "foo"],
    ["the rest of the word", "f|oo bar", false, "f| bar", "oo"],
    ["whitespace and the word after it", "foo|  bar.", false, "foo|.", "  bar"],
    ["across line breaks and blank lines", "foo|\n\n  bar x", false, "foo| x", "\n\n  bar"],
    ["the whitespace left at the end of the text", "foo|\n  \n", false, "foo|", "\n  \n"],
    ["the whole identifier without CamelHumps", "|fooBar x", false, "| x", "fooBar"],
    ["one hump with CamelHumps", "|fooBar x", true, "|Bar x", "foo"],
  ])("Kill to Word End cuts %s", (_, text, camelHumps, after, cut) => {
    expect(run(killToWordEnd(camelHumps), text)).toBe(after);
    expect(writeClipboardText).toHaveBeenLastCalledWith(cut);
  });

  it("cuts from the caret, not the selection, and from every caret", () => {
    expect(run(killToWordStart(false), "a [b]c d")).toBe("a |c d");
    expect(writeClipboardText).toHaveBeenLastCalledWith("b");
    expect(run(killToWordEnd(false), "a| b\nc| d")).toBe("a|\nc|");
    expect(writeClipboardText).toHaveBeenLastCalledWith(" b\n d");
  });

  it("collects repeated kills at the same caret: forward ones after, backward ones before", () => {
    const v = make("one two| three four");
    killToWordStart(false)(v);
    killToWordStart(false)(v);
    expect(show(v)).toBe("| three four");
    expect(clipboardHistory().map((e) => e.text)).toEqual(["one two"]);
    killToWordEnd(false)(v);
    cutToLineEnd(v);
    expect(show(v)).toBe("|");
    expect(writeClipboardText).toHaveBeenLastCalledWith("one two three four");
    expect(clipboardHistory().map((e) => e.text)).toEqual(["one two three four"]);
  });

  it("starts a new entry after a caret move", () => {
    const v = make("ab cd|");
    killToWordStart(false)(v);
    v.dispatch({ selection: { anchor: 0 } });
    killToWordEnd(false)(v);
    expect(show(v)).toBe("| ");
    expect(clipboardHistory().map((e) => e.text)).toEqual(["ab", "cd"]);
  });

  it("leaves the clipboard alone with nothing to cut or in a read-only editor", () => {
    expect(run(killToWordStart(false), "  \n|ab")).toBe("|ab");
    vi.mocked(writeClipboardText).mockClear();
    clearClipboardHistory();
    expect(run(killToWordStart(false), "|ab")).toBe("|ab");
    expect(run(killToWordEnd(true), "ab|")).toBe("ab|");
    const v = make("a|b", true);
    expect(killToWordStart(false)(v)).toBe(false);
    expect(killToWordEnd(false)(v)).toBe(false);
    expect(show(v)).toBe("a|b");
    expect(writeClipboardText).not.toHaveBeenCalled();
    expect(clipboardHistory()).toEqual([]);
  });
});

describe("Hungry Backspace", () => {
  it.each([
    ["the spaces before the caret", "ab   |cd", "ab|cd"],
    ["tabs, blank lines and line breaks too", "ab\n\t\n  |cd", "ab|cd"],
    ["whitespace up to the start of the text", " \n\t|x", "|x"],
    ["only before the caret", "a |  b", "a|  b"],
    ["one character after anything else", "ab|cd", "a|cd"],
    ["a whole surrogate pair", "a\u{1F600}|b", "a|b"],
    ["an empty bracket pair, like Backspace", "f(|)", "f|"],
    ["a selection as it is", "a[b ]c", "a|c"],
    ["nothing at the start of the text", "|ab", "|ab"],
    ["whitespace or a character at each caret", "a  |b|\n  |c", "a|c"],
    ["one run shared by two carets", "a  |  |b", "a|b"],
    ["a selection beside a caret after whitespace", "[ab]  |c", "|c"],
  ])("deletes %s", (_, text, expected) => {
    expect(run(hungryBackspace, text)).toBe(expected);
  });

  it("does nothing in a read-only editor", () => {
    const v = make("ab  |cd", true);
    expect(hungryBackspace(v)).toBe(false);
    expect(show(v)).toBe("ab  |cd");
  });
});
