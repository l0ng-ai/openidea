import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorState, Transaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { history, redo, redoDepth, undo, undoDepth } from "@codemirror/commands";
import { remoteChange, workspaceEditHistory } from "@/editor/api";
import { WorkspaceHistory } from "@/editor/core/model/workspaceHistory";
import { emitLocalIdeEvent } from "@/platform/ipc";
import { beginHistoryGroup, endHistoryGroup, historyGroupExtension } from "./historyGroup";
import { endInplaceRename, inplaceRenameActive, inplaceRenameExtension, startInplaceRename } from "./inplaceRename";

const commands = vi.hoisted(() => ({ undoWorkspaceEdit: vi.fn(), redoWorkspaceEdit: vi.fn() }));
vi.mock("@/bindings", () => ({ commands }));

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

describe("history group around a workspace refactoring", () => {
  const BEFORE = "f(1 + 2);";
  // The server's edit (the refactoring), then the in-place rename of `v` to `sum`.
  const SERVER = "int v = 1 + 2;\nf(v);";
  const RENAMED = "int sum = 1 + 2;\nf(sum);";
  const cleanups: Array<() => void> = [];
  afterEach(() => cleanups.splice(0).forEach((c) => c()));

  function setup() {
    const notify = vi.fn();
    const workspace = new WorkspaceHistory(async () => {}, notify);
    cleanups.push(workspace.start());
    let view: EditorView | null = null;
    const target = { path: "/p/A.java", state: () => view!.state, dispatch: (tr: Transaction) => view!.dispatch(tr) };
    view = new EditorView({
      state: EditorState.create({
        doc: BEFORE,
        extensions: [history(), historyGroupExtension, inplaceRenameExtension(), workspace.extension(target)],
      }),
    });
    views.push(view);
    cleanups.push(workspace.attach(target));
    const remote = (text: string) =>
      view!.dispatch({
        changes: { from: 0, to: view!.state.doc.length, insert: text },
        annotations: [remoteChange.of(true), Transaction.addToHistory.of(false)],
      });
    const seen: string[] = [];
    commands.undoWorkspaceEdit.mockReset().mockImplementation(async () => {
      seen.push(view!.state.doc.toString());
      remote(BEFORE);
      return { status: "ok", data: null };
    });
    commands.redoWorkspaceEdit.mockReset().mockImplementation(async () => {
      seen.push(view!.state.doc.toString());
      remote(SERVER);
      return { status: "ok", data: null };
    });
    const refactor = () => {
      beginHistoryGroup(view!);
      remote(SERVER);
      emitLocalIdeEvent({ type: "workspaceEditApplied", id: 9, paths: ["/p/A.java"], moves: [], byAgent: false });
    };
    // "int v = 1 + 2;\nf(v);": v at 4 and 17.
    const rename = () =>
      startInplaceRename(view!, {
        primary: { from: 17, to: 18 },
        others: [{ from: 4, to: 5 }],
        hint: "",
        commit: (name) =>
          view!.dispatch({
            changes: [
              { from: 4, to: 5, insert: name },
              { from: 17, to: 18, insert: name },
            ],
          }),
        dialog: () => {},
        onEnd: () => endHistoryGroup(view!, "refactor.introduce"),
      });
    return { view, notify, seen, refactor, rename };
  }

  it("undoes the refactoring with the rename that finished it in one step, and redoes both", async () => {
    const { view, notify, seen, refactor, rename } = setup();
    refactor();
    rename();
    view.dispatch({ changes: { from: 17, to: 18, insert: "sum" } });
    endInplaceRename(view, "commit");
    expect(view.state.doc.toString()).toBe(RENAMED);
    expect(undoDepth(view.state)).toBe(1);

    expect(undo(view)).toBe(true);
    await vi.waitFor(() => expect(view.state.doc.toString()).toBe(BEFORE));
    // The backend restores the files while they still hold the refactoring's own text.
    expect(seen).toEqual([SERVER]);
    expect(redoDepth(view.state)).toBe(1);

    expect(redo(view)).toBe(true);
    await vi.waitFor(() => expect(view.state.doc.toString()).toBe(RENAMED));
    expect(undoDepth(view.state)).toBe(1);

    await workspaceEditHistory(9);
    expect(view.state.doc.toString()).toBe(BEFORE);
    expect(seen).toEqual([SERVER, BEFORE, SERVER]);
    expect(notify).not.toHaveBeenCalled();
  });

  it("undoes a quick fix with its reformatting in one step; a nested group leaves it to the outer one", async () => {
    const { view, seen, refactor } = setup();
    refactor();
    expect(beginHistoryGroup(view)).toBe(false);
    view.dispatch({ changes: { from: 0, insert: "  " }, userEvent: "format" });
    endHistoryGroup(view, "quickfix");
    expect(undoDepth(view.state)).toBe(1);
    expect(undo(view)).toBe(true);
    await vi.waitFor(() => expect(view.state.doc.toString()).toBe(BEFORE));
    expect(seen).toEqual([SERVER]);
  });

  it("finishes an open in-place rename before the notification's Undo", async () => {
    const { view, seen, refactor, rename } = setup();
    refactor();
    rename();
    view.dispatch({ changes: { from: 17, to: 18, insert: "sum" } });
    await workspaceEditHistory(9);
    expect(inplaceRenameActive(view.state)).toBe(false);
    expect(view.state.doc.toString()).toBe(BEFORE);
    expect(seen).toEqual([SERVER]);
  });

  it("refuses the notification's Undo after newer typing, keeping the rename", async () => {
    const { view, refactor, rename } = setup();
    refactor();
    rename();
    view.dispatch({ changes: { from: 17, to: 18, insert: "sum" } });
    endInplaceRename(view, "commit");
    view.dispatch({ changes: { from: 0, insert: "// x\n" }, userEvent: "input.type" });
    await expect(workspaceEditHistory(9)).rejects.toThrow("Undo newer editor changes");
    expect(commands.undoWorkspaceEdit).not.toHaveBeenCalled();
    expect(view.state.doc.toString()).toBe(`// x\n${RENAMED}`);
  });

  it("puts the rename back when the backend refuses the restore", async () => {
    const { view, refactor, rename } = setup();
    refactor();
    rename();
    view.dispatch({ changes: { from: 17, to: 18, insert: "sum" } });
    endInplaceRename(view, "commit");
    commands.undoWorkspaceEdit.mockResolvedValue({ status: "error", error: { kind: "outOfSync", message: "changed" } });
    await expect(workspaceEditHistory(9)).rejects.toThrow();
    expect(view.state.doc.toString()).toBe(RENAMED);
    expect(undoDepth(view.state)).toBe(1);
  });
});
