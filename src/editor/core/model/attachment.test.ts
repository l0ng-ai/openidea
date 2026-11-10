import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorView } from "@codemirror/view";
import { history, undo } from "@codemirror/commands";
import { editorsFor } from "@/editor/api";
import { createMemoryBackend } from "../backend";
import { _resetLanguages } from "../cm/languages";
import { attachDocument } from "./attachment";
import { DocumentManager, useDocMeta } from "./document";
import { EditorSlot, type SlotHost } from "./slot";

const host: SlotHost = {
  onFocus: () => {},
  onBlur: () => {},
  onSelection: () => {},
  onUserEdit: () => {},
  onContextMenu: () => {},
};

async function settle() {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
}

function setup(files: Record<string, string>) {
  _resetLanguages();
  const backend = createMemoryBackend(files);
  const scheduled: Array<() => void> = [];
  const manager = new DocumentManager(backend, { settings: () => ({}), notify: vi.fn() }, (fn) => scheduled.push(fn));
  manager.start();
  const frame = async () => {
    scheduled.splice(0).forEach((f) => f());
    await settle();
  };
  return { backend, manager, frame };
}

afterEach(() => useDocMeta.setState({}, true));

describe("attached document views (editable diff side)", () => {
  it("can save a confirmed merge result without trimming or adding a final newline", async () => {
    const { backend, manager } = setup({ "/p/merge.txt": "old\n" });
    const att = await attachDocument(manager, "/p/merge.txt");
    const view = new EditorView({ doc: att.text(), extensions: [att.extension] });
    const model = manager.get("/p/merge.txt")!;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "标题😀  \nexact result  " } });
    await att.save({ exact: true });
    expect(view.state.doc.toString()).toBe("标题😀  \nexact result  ");
    expect(backend.docs.get(model.doc)?.text).toBe("标题😀  \nexact result  ");
    expect(useDocMeta.getState()["/p/merge.txt"]?.dirty).toBe(false);
    view.destroy();
    att.release();
  });

  it("shares the document with editor tabs both ways and syncs to the backend", async () => {
    const { backend, manager, frame } = setup({ "/p/a.txt": "one\ntwo\n" });
    const model = await manager.acquire("/p/a.txt");
    const tab = new EditorSlot(model, "t1", host);
    const att = await attachDocument(manager, "/p/a.txt");
    expect(att.readOnly).toBe(false);
    const view = new EditorView({ doc: att.text(), extensions: [att.extension, history()] });
    expect(editorsFor("/p/a.txt").some((h) => h.view === view)).toBe(true);

    // Typing in the diff reaches the tab and the backend.
    view.dispatch({ changes: { from: 0, insert: ">" }, userEvent: "input.type" });
    expect(tab.currentState().doc.toString()).toBe(">one\ntwo\n");
    await frame();
    expect(backend.docs.get(model.doc)?.text).toBe(">one\ntwo\n");
    expect(useDocMeta.getState()["/p/a.txt"]?.dirty).toBe(true);

    // Typing in the tab is mirrored into the diff, without entering its undo history.
    tab.dispatchLocal({ changes: { from: 4, insert: "!" } });
    expect(view.state.doc.toString()).toBe(">one!\ntwo\n");
    undo(view);
    expect(view.state.doc.toString()).toBe("one!\ntwo\n");
    expect(tab.currentState().doc.toString()).toBe("one!\ntwo\n");

    // Save goes through the document (Save All saves it too).
    await att.save();
    expect(useDocMeta.getState()["/p/a.txt"]?.dirty).toBe(false);
    view.destroy();
    att.release();
    tab.dispose();
  });

  it("keeps the document open while attached and makes backend patches undoable without tabs", async () => {
    const { backend, manager } = setup({ "/p/b.txt": "abc" });
    const att = await attachDocument(manager, "/p/b.txt");
    const view = new EditorView({ doc: att.text(), extensions: [att.extension, history()] });
    const model = manager.get("/p/b.txt")!;
    backend.patch(model.doc, [{ from: 0, to: 1, insert: "X" }]);
    expect(view.state.doc.toString()).toBe("Xbc");
    undo(view);
    expect(view.state.doc.toString()).toBe("abc");
    view.destroy();
    att.release();
    await settle();
    expect(manager.get("/p/b.txt")).toBeUndefined();
  });

  it("catches up when the document changed before the view was created", async () => {
    const { manager } = setup({ "/p/c.txt": "old" });
    const model = await manager.acquire("/p/c.txt");
    const tab = new EditorSlot(model, "t1", host);
    const att = await attachDocument(manager, "/p/c.txt");
    const stale = att.text();
    tab.dispatchLocal({ changes: { from: 0, to: 3, insert: "new" } });
    const view = new EditorView({ doc: stale, extensions: [att.extension] });
    await settle();
    expect(view.state.doc.toString()).toBe("new");
    view.destroy();
    att.release();
    tab.dispose();
  });

  it("undoes backend edits in the document's history: the text tab's when one is open (custom editors)", async () => {
    const { backend, manager, frame } = setup({ "/p/c.csv": "a,b\n" });
    const att = await attachDocument(manager, "/p/c.csv");
    const view = new EditorView({ doc: att.text(), extensions: [att.extension, history()] });
    const model = manager.get("/p/c.csv")!;
    expect(att.doc).toBe(model.doc);

    // No tab: the attachment holds the history.
    backend.patch(model.doc, [{ from: 0, to: 1, insert: "X" }]);
    expect(att.undo()).toBe(true);
    expect(view.state.doc.toString()).toBe("a,b\n");
    expect(att.redo()).toBe(true);
    expect(view.state.doc.toString()).toBe("X,b\n");
    await frame();
    await att.synced();
    expect(backend.docs.get(model.doc)?.text).toBe("X,b\n");

    // With a text tab, backend edits are recorded there: undo from the custom editor reaches it.
    const tab = new EditorSlot(model, "t1", host);
    backend.patch(model.doc, [{ from: 2, to: 3, insert: "Y" }]);
    expect(tab.currentState().doc.toString()).toBe("X,Y\n");
    expect(att.undo()).toBe(true);
    expect(tab.currentState().doc.toString()).toBe("X,b\n");
    expect(view.state.doc.toString()).toBe("X,b\n");
    view.destroy();
    att.release();
    tab.dispose();
  });

  it("records an attachment's own edits in the document's history: the text tab's when one is open", async () => {
    const { manager } = setup({ "/p/d.excalidraw": "{}" });
    const att = await attachDocument(manager, "/p/d.excalidraw");
    const view = new EditorView({ doc: att.text(), extensions: [att.extension, history()] });
    const model = manager.get("/p/d.excalidraw")!;

    // No tab: the view's own history.
    att.edit({ from: 1, insert: "a" });
    expect(view.state.doc.toString()).toBe("{a}");
    expect(att.undo()).toBe(true);
    expect(view.state.doc.toString()).toBe("{}");

    // With a text tab: the edit is the tab's, so Undo there reverts it, and the view follows.
    const tab = new EditorSlot(model, "t1", host);
    att.edit({ from: 1, insert: "b" }, "input.plugin");
    expect(tab.currentState().doc.toString()).toBe("{b}");
    expect(view.state.doc.toString()).toBe("{b}");
    // `undo` runs where the history is: the tab's (what ⌘Z in the text editor runs).
    expect(att.undo()).toBe(true);
    expect(tab.currentState().doc.toString()).toBe("{}");
    expect(view.state.doc.toString()).toBe("{}");
    // The view's own history never had it.
    expect(undo(view)).toBe(false);
    view.destroy();
    att.release();
    tab.dispose();
  });
});
