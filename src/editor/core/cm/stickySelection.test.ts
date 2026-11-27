import { afterEach, describe, expect, it } from "vitest";
import { EditorSelection, EditorState, type Extension } from "@codemirror/state";
import { EditorView, keymap, runScopeHandlers, type Command } from "@codemirror/view";
import { selectAll } from "@codemirror/commands";
import { editorBaseKeymap } from "./baseKeymap";
import { swapSelectionBoundaries } from "./editing";
import { cursorMatchBrace } from "./caretCommands";
import { isStickySelection, stickyMove, stickySelectionField, toggleStickySelection } from "./stickySelection";

const views: EditorView[] = [];
afterEach(() => views.splice(0).forEach((v) => v.destroy()));

/** `|` marks carets, `[`/`]` a selection. */
function make(text: string, extra: Extension = []) {
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
      extensions: [
        EditorState.allowMultipleSelections.of(true),
        stickySelectionField,
        keymap.of(editorBaseKeymap),
        extra,
      ],
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

const press = (view: EditorView, key: string, mods: KeyboardEventInit = {}) =>
  runScopeHandlers(view, new KeyboardEvent("keydown", { key, ...mods }), "editor");

describe("Toggle Sticky Selection", () => {
  it("extends the selection with caret moves until it is turned off", () => {
    const v = make("ab|cdef\nghijkl");
    toggleStickySelection(v);
    expect(isStickySelection(v.state)).toBe(true);
    press(v, "ArrowRight");
    press(v, "ArrowRight");
    expect(show(v)).toBe("ab[cd]ef\nghijkl");
    press(v, "ArrowLeft");
    expect(show(v)).toBe("ab[c]def\nghijkl");
    press(v, "ArrowDown");
    expect(v.state.selection.main).toMatchObject({ anchor: 2, head: 10 });
    press(v, "ArrowRight");
    toggleStickySelection(v);
    expect(isStickySelection(v.state)).toBe(false);
    expect(show(v)).toBe("abcdef\nghij|kl");
    press(v, "ArrowRight");
    expect(show(v)).toBe("abcdef\nghijk|l");
  });

  it("starts at the caret, not at an existing selection", () => {
    const v = make("a[bc]de");
    toggleStickySelection(v);
    expect(show(v)).toBe("abc|de");
    press(v, "ArrowRight");
    expect(show(v)).toBe("abc[d]e");
  });

  it("extends every caret from its own start", () => {
    const v = make("|abc\n|def");
    toggleStickySelection(v);
    press(v, "ArrowRight");
    press(v, "ArrowRight");
    expect(show(v)).toBe("[ab]c\n[de]f");
  });

  it("is turned off by Escape, which removes the selection and the other carets", () => {
    const v = make("|abc\n|def");
    toggleStickySelection(v);
    press(v, "ArrowRight");
    expect(show(v)).toBe("[a]bc\n[d]ef");
    expect(press(v, "Escape")).toBe(true);
    expect(isStickySelection(v.state)).toBe(false);
    expect(show(v)).toBe("a|bc\ndef");
    press(v, "ArrowRight");
    expect(show(v)).toBe("ab|c\ndef");
  });

  it("leaves Escape to the editor while it is off", () => {
    const v = make("[ab]c");
    expect(press(v, "Escape")).toBe(true);
    expect(show(v)).toBe("ab|c");
    expect(isStickySelection(v.state)).toBe(false);
  });

  it("extends with caret moves outside the keymap and keeps its start on Select All", () => {
    const v = make("x(ab|)y");
    toggleStickySelection(v);
    cursorMatchBrace(v);
    expect(show(v)).toBe("x([ab])y");
    expect(v.state.selection.main).toMatchObject({ anchor: 4, head: 2 });
    selectAll(v);
    expect(v.state.selection.main).toMatchObject({ anchor: 4, head: 6 });
  });

  it("leaves an editor without sticky selection alone", () => {
    const v = new EditorView({ state: EditorState.create({ doc: "abc", selection: EditorSelection.range(0, 2) }) });
    views.push(v);
    expect(toggleStickySelection(v)).toBe(false);
    expect(v.state.selection.main).toMatchObject({ anchor: 0, head: 2 });
  });

  it("runs a binding's Shift variant only while it is on", () => {
    const calls: string[] = [];
    const cmd =
      (name: string): Command =>
      () => (calls.push(name), true);
    const v = make("|abc");
    const b = stickyMove({ key: "Alt-ArrowRight", run: cmd("move"), shift: cmd("select") });
    b.run!(v);
    toggleStickySelection(v);
    b.run!(v);
    expect(calls).toEqual(["move", "select"]);
    const same = { key: "Enter", run: cmd("enter"), shift: cmd("enter") };
    same.shift = same.run;
    expect(stickyMove(same)).toBe(same);
  });

  it("keeps going from the other end after Swap Selection Boundaries", () => {
    const v = make("ab|cdef");
    toggleStickySelection(v);
    press(v, "ArrowRight");
    press(v, "ArrowRight");
    swapSelectionBoundaries(v);
    press(v, "ArrowLeft");
    expect(show(v)).toBe("a[bcd]ef");
    expect(v.state.selection.main.head).toBe(1);
  });

  it("turns off when the document changes, as in IDEA", () => {
    const v = make("|abc");
    toggleStickySelection(v);
    press(v, "ArrowRight");
    v.dispatch(v.state.replaceSelection("X"));
    expect(show(v)).toBe("X|bc");
    expect(isStickySelection(v.state)).toBe(false);
    press(v, "ArrowRight");
    expect(show(v)).toBe("Xb|c");
  });

  it("turns off and removes the selection after a copy", async () => {
    const v = make("|abc");
    toggleStickySelection(v);
    press(v, "ArrowRight");
    v.contentDOM.dispatchEvent(new Event("copy", { bubbles: true, cancelable: true }));
    await Promise.resolve();
    expect(isStickySelection(v.state)).toBe(false);
    expect(show(v)).toBe("a|bc");
  });

  it("works in a read-only editor", () => {
    const v = make("|abc", EditorState.readOnly.of(true));
    toggleStickySelection(v);
    press(v, "ArrowRight");
    expect(show(v)).toBe("[a]bc");
  });
});
