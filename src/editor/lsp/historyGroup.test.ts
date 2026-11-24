import { afterEach, describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { history, redo, undo, undoDepth } from "@codemirror/commands";
import { beginHistoryGroup, endHistoryGroup, historyGroupExtension } from "./historyGroup";
import { endInplaceRename, inplaceRenameExtension, startInplaceRename } from "./inplaceRename";

const views: EditorView[] = [];
afterEach(() => views.splice(0).forEach((v) => v.destroy()));

function make(doc: string) {
  const view = new EditorView({
    state: EditorState.create({ doc, extensions: [history(), historyGroupExtension, inplaceRenameExtension()] }),
  });
  views.push(view);
  return view;
}

describe("history group", () => {
  it("undoes an edit made of several transactions in one step", () => {
    const view = make("f(1 + 2);");
    view.dispatch({ changes: { from: 0, insert: "x;" }, userEvent: "input.type" });
    const depth = undoDepth(view.state);
    beginHistoryGroup(view);
    // A server edit, then its reformatting.
    view.dispatch({
      changes: [
        { from: 2, insert: "int v = 1 + 2;\n" },
        { from: 4, to: 9, insert: "v" },
      ],
    });
    view.dispatch({ changes: { from: 2, insert: "  " }, userEvent: "format" });
    endHistoryGroup(view, "refactor.introduce");
    expect(view.state.doc.toString()).toBe("x;  int v = 1 + 2;\nf(v);");
    expect(undoDepth(view.state)).toBe(depth + 1);
    undo(view);
    expect(view.state.doc.toString()).toBe("x;f(1 + 2);");
    redo(view);
    expect(view.state.doc.toString()).toBe("x;  int v = 1 + 2;\nf(v);");
    undo(view);
    undo(view);
    expect(view.state.doc.toString()).toBe("f(1 + 2);");
  });

  it("closes with the in-place rename of the introduced name", () => {
    const view = make("f(1 + 2);");
    beginHistoryGroup(view);
    view.dispatch({
      changes: [
        { from: 0, insert: "int extracted = 1 + 2;\n" },
        { from: 2, to: 7, insert: "extracted" },
      ],
    });
    // "int extracted = 1 + 2;\nf(extracted);" — extracted at 4 and 25.
    startInplaceRename(view, {
      primary: { from: 25, to: 34 },
      others: [{ from: 4, to: 13 }],
      hint: "",
      commit: (name) =>
        view.dispatch({
          changes: [
            { from: 4, to: 13, insert: name },
            { from: 25, to: 34, insert: name },
          ],
        }),
      dialog: () => {},
      onEnd: () => endHistoryGroup(view, "refactor.introduce"),
    });
    view.dispatch({ changes: { from: 25, to: 34, insert: "sum" } });
    endInplaceRename(view, "commit");
    expect(view.state.doc.toString()).toBe("int sum = 1 + 2;\nf(sum);");
    undo(view);
    expect(view.state.doc.toString()).toBe("f(1 + 2);");
  });

  it("records nothing for a group without changes, and edits after it undo on their own", () => {
    const view = make("a");
    beginHistoryGroup(view);
    endHistoryGroup(view, "refactor.introduce");
    expect(undoDepth(view.state)).toBe(0);
    view.dispatch({ changes: { from: 1, insert: "b" }, userEvent: "input.type" });
    expect(undoDepth(view.state)).toBe(1);
  });
});
