import { afterEach, describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { history, redo, undo } from "@codemirror/commands";
import { javascript } from "@codemirror/lang-javascript";
import { moveStatementDown } from "./editing";

const views: EditorView[] = [];
afterEach(() => views.splice(0).forEach((v) => v.destroy()));

describe("Move Statement and Redo", () => {
  it("puts the caret back where the move left it", () => {
    const doc = "function f() {\n  const x = 1;\n  const y = 2;\n  return x + y;\n}\n";
    const v = new EditorView({
      state: EditorState.create({
        doc,
        selection: { anchor: doc.indexOf("x = 1") },
        extensions: [history(), javascript({ typescript: true })],
      }),
      parent: document.body,
    });
    views.push(v);
    moveStatementDown(v);
    const after = v.state.selection.main.head;
    expect(v.state.doc.line(3).text).toBe("  const x = 1;");
    undo(v);
    redo(v);
    expect(v.state.selection.main.head).toBe(after);
  });
});
