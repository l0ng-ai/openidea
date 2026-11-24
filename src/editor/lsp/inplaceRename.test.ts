import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorSelection, EditorState, type Extension } from "@codemirror/state";
import { history, undoDepth } from "@codemirror/commands";
import { EditorView } from "@codemirror/view";
import {
  cycleSuggestion,
  endInplaceRename,
  inplaceRenameActive,
  inplaceRenameExtension,
  startInplaceRename,
} from "./inplaceRename";

const views: EditorView[] = [];
afterEach(() => views.splice(0).forEach((v) => v.destroy()));

// "let foo = 1; foo + foo;" — foo at 4, 13 and 19.
function session(commit = vi.fn(), dialog = vi.fn(), extensions: Extension[] = []) {
  const view = new EditorView({
    state: EditorState.create({
      doc: "let foo = 1; foo + foo;",
      extensions: [inplaceRenameExtension(), ...extensions],
    }),
  });
  views.push(view);
  startInplaceRename(view, {
    primary: { from: 4, to: 7 },
    others: [
      { from: 13, to: 16 },
      { from: 19, to: 22 },
    ],
    hint: "Press ⇧F6 to show dialog with more options",
    commit,
    dialog,
  });
  return { view, commit, dialog };
}

const type = (view: EditorView, from: number, to: number, insert: string) =>
  view.dispatch({
    changes: { from, to, insert },
    selection: EditorSelection.cursor(from + insert.length),
    userEvent: "input.type",
  });

describe("in-place rename", () => {
  it("preselects the name and mirrors edits to the other occurrences", () => {
    const { view } = session();
    expect(view.state.selection.main).toMatchObject({ from: 4, to: 7 });
    type(view, 4, 7, "bar");
    expect(view.state.doc.toString()).toBe("let bar = 1; bar + bar;");
    type(view, 7, 7, "Baz");
    expect(view.state.doc.toString()).toBe("let barBaz = 1; barBaz + barBaz;");
    expect(inplaceRenameActive(view.state)).toBe(true);
  });

  it("restores the old name on cancel without committing", () => {
    const { view, commit } = session();
    type(view, 4, 7, "x");
    expect(endInplaceRename(view, "cancel")).toBe("x");
    expect(view.state.doc.toString()).toBe("let foo = 1; foo + foo;");
    expect(inplaceRenameActive(view.state)).toBe(false);
    expect(commit).not.toHaveBeenCalled();
  });

  it("puts the old text back before committing the typed name", () => {
    const commit = vi.fn();
    const { view } = session(commit);
    type(view, 4, 7, "count");
    commit.mockImplementation(() => expect(view.state.doc.toString()).toBe("let foo = 1; foo + foo;"));
    endInplaceRename(view, "commit");
    expect(commit).toHaveBeenCalledWith("count");
  });

  it("keeps the session's edits out of the undo history", () => {
    const { view } = session(vi.fn(), vi.fn(), [history()]);
    type(view, 4, 7, "bar");
    expect(undoDepth(view.state)).toBe(0);
    endInplaceRename(view, "cancel");
    expect(undoDepth(view.state)).toBe(0);
  });

  it("commits when the caret leaves the name", async () => {
    const { view, commit } = session();
    type(view, 4, 7, "bar");
    view.dispatch({ selection: EditorSelection.cursor(0) });
    await Promise.resolve();
    expect(commit).toHaveBeenCalledWith("bar");
    expect(inplaceRenameActive(view.state)).toBe(false);
  });
});

describe("in-place rename edits elsewhere", () => {
  it("finishes the rename when text outside the name changes", async () => {
    const { view, commit } = session();
    type(view, 4, 7, "bar");
    view.dispatch({ changes: { from: 0, to: 0, insert: "// x\n" }, userEvent: "input.type" });
    await Promise.resolve();
    expect(commit).toHaveBeenCalledWith("bar");
  });

  it("cycles name suggestions with ↑ / ↓, mirrored and committed like typing", () => {
    const view = new EditorView({
      state: EditorState.create({ doc: "let foo = 1; foo + foo;", extensions: [inplaceRenameExtension()] }),
    });
    views.push(view);
    const commit = vi.fn();
    startInplaceRename(view, {
      primary: { from: 4, to: 7 },
      others: [{ from: 13, to: 16 }],
      hint: "",
      suggestions: ["count", "total"],
      commit,
      dialog: vi.fn(),
    });
    expect(cycleSuggestion(view, 1)).toBe(true);
    expect(view.state.doc.toString()).toBe("let count = 1; count + foo;");
    expect(view.state.selection.main).toMatchObject({ from: 4, to: 9 });
    cycleSuggestion(view, 1);
    expect(view.state.doc.toString()).toBe("let total = 1; total + foo;");
    cycleSuggestion(view, 1);
    expect(view.state.doc.toString()).toBe("let count = 1; count + foo;");
    endInplaceRename(view, "commit");
    expect(commit).toHaveBeenCalledWith("count");
    expect(view.state.doc.toString()).toBe("let foo = 1; foo + foo;");
  });

  it("puts a clicked suggestion in, and finishes on a double click", () => {
    const view = new EditorView({
      parent: document.body,
      state: EditorState.create({ doc: "let foo = 1; foo + foo;", extensions: [inplaceRenameExtension()] }),
    });
    views.push(view);
    const commit = vi.fn();
    startInplaceRename(view, {
      primary: { from: 4, to: 7 },
      others: [{ from: 13, to: 16 }],
      hint: "",
      suggestions: ["count", "total"],
      commit,
      dialog: vi.fn(),
    });
    const item = (name: string) =>
      [...view.dom.querySelectorAll<HTMLButtonElement>(".cm-lsp-inplace-suggestions button")].find(
        (button) => button.textContent === name,
      )!;
    item("total").dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, detail: 1 }));
    expect(view.state.doc.toString()).toBe("let total = 1; total + foo;");
    expect(inplaceRenameActive(view.state)).toBe(true);
    item("count").dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, detail: 2 }));
    expect(commit).toHaveBeenCalledWith("count");
    expect(inplaceRenameActive(view.state)).toBe(false);
  });

  it("leaves the arrows alone without suggestions", () => {
    const { view } = session();
    expect(cycleSuggestion(view, 1)).toBe(false);
  });
});
