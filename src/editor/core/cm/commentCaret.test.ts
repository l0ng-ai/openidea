import { afterEach, describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { history, redo, undo } from "@codemirror/commands";
import { javascript } from "@codemirror/lang-javascript";
import { commentBlock, commentLine } from "./comments";

const views: EditorView[] = [];
afterEach(() => views.splice(0).forEach((v) => v.destroy()));

function make(doc: string, anchor: number) {
  const v = new EditorView({
    state: EditorState.create({ doc, selection: { anchor }, extensions: [history(), javascript()] }),
    parent: document.body,
  });
  views.push(v);
  return v;
}

describe("comment commands and the caret", () => {
  it("puts the caret back where ⌘/ left it on Redo", () => {
    const doc = "function f() {\n  let a = 1;\n  let b = 2;\n}\n";
    const v = make(doc, doc.indexOf("a = 1"));
    commentLine(v);
    const after = v.state.selection.main.head;
    expect(v.state.doc.line(2).text).toBe("//  let a = 1;");
    undo(v);
    redo(v);
    expect(v.state.selection.main.head).toBe(after);
  });

  it("puts the caret inside an empty block comment on a blank line", () => {
    const v = make("function f() {\n  \n}\n", 17);
    commentBlock(v);
    const s = v.state;
    const h = s.selection.main.head;
    expect(s.sliceDoc(0, h) + "|" + s.sliceDoc(h)).toBe("function f() {\n  /* | */\n}\n");
  });
});
