import { afterEach, describe, expect, it, vi } from "vitest";
import { history } from "@codemirror/commands";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { editCommand } from "../appActions";
import * as contributions from "@/workbench/contributions";

describe("Edit menu Undo / Redo", () => {
  let view: EditorView | null = null;
  afterEach(() => {
    view?.destroy();
    view = null;
    vi.restoreAllMocks();
  });

  it("use the focused editor's history, including programmatic edits", () => {
    view = new EditorView({ state: EditorState.create({ doc: "a", extensions: history() }), parent: document.body });
    view.dispatch({ changes: { from: 1, insert: "b" }, userEvent: "input.complete" });
    view.contentDOM.focus();
    editCommand("undo")();
    expect(view.state.doc.toString()).toBe("a");
    editCommand("redo")();
    expect(view.state.doc.toString()).toBe("ab");
  });

  it("routes custom document history before CodeMirror's independent local history", () => {
    const parent = document.createElement("div");
    parent.dataset.paneId = "custom-pane";
    document.body.appendChild(parent);
    view = new EditorView({ state: EditorState.create({ doc: "local", extensions: history() }), parent });
    view.dispatch({ changes: { from: 5, insert: " edit" }, userEvent: "input" });
    let source = "backend edited";
    vi.spyOn(contributions, "maybeEditorService").mockReturnValue({
      openFile: async () => {},
      openInput: async () => {},
      activePath: () => "/p/notebook.ipynb",
      activeCursor: () => null,
      saveAll: async () => {},
      documentHistory: (command) => {
        source = command === "undo" ? "backend original" : "backend edited";
        return true;
      },
    });
    view.contentDOM.focus();
    editCommand("undo")();
    expect(source).toBe("backend original");
    expect(view.state.doc.toString()).toBe("local edit");
    editCommand("redo")();
    expect(source).toBe("backend edited");
    expect(view.state.doc.toString()).toBe("local edit");
    parent.remove();
  });
});
