import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorView } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { history, undo } from "@codemirror/commands";
import { editorsFor } from "@/editor/api";
import type { Settings } from "@/bindings";
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

function setup(files: Record<string, string>, settings: Settings = {}) {
  _resetLanguages();
  const backend = createMemoryBackend(files);
  const scheduled: Array<() => void> = [];
  const manager = new DocumentManager(backend, { settings: () => settings, notify: vi.fn() }, (fn) =>
    scheduled.push(fn),
  );
  manager.start();
  const frame = async () => {
    scheduled.splice(0).forEach((f) => f());
    await settle();
  };
  return { backend, manager, frame };
}

afterEach(() => useDocMeta.setState({}, true));

describe("attached document views (editable diff side)", () => {
  it.each([
    { autoSave: true, tabOpen: false, ensureFinalNewline: false },
    { autoSave: false, tabOpen: false, ensureFinalNewline: false },
    { autoSave: true, tabOpen: true, ensureFinalNewline: false },
    { autoSave: true, tabOpen: true, ensureFinalNewline: true },
  ])(
    "saves reverted diff edits on blur respecting $autoSave / $tabOpen / $ensureFinalNewline",
    async ({ autoSave, tabOpen, ensureFinalNewline }) => {
      const { backend, manager, frame } = setup(
        { "/p/a.txt": "original\n" },
        { files: { autoSave, ensureFinalNewline } },
      );
      const att = await attachDocument(manager, "/p/a.txt");
      const tab = tabOpen ? new EditorSlot(manager.get("/p/a.txt")!, "t1", host) : null;
      const parent = document.createElement("div");
      const elsewhere = document.createElement("button");
      document.body.append(parent, elsewhere);
      const view = new EditorView({ parent, doc: att.text(), extensions: [att.extension] });
      try {
        view.focus();
        view.dispatch({ changes: { from: 8, to: 9 }, userEvent: "delete.backward" });
        elsewhere.focus();
        await frame();
        expect(backend.docs.get(att.doc)?.saved).toBe(autoSave && !ensureFinalNewline ? "original" : "original\n");
        expect(att.dirty()).toBe(!autoSave);
        if (!autoSave) {
          await att.save();
          expect(backend.docs.get(att.doc)?.saved).toBe("original");
        }
      } finally {
        view.destroy();
        att.release();
        tab?.dispose();
        manager.stop();
        parent.remove();
        elsewhere.remove();
      }
    },
  );

  it("cancels popup-delayed autosave when an attached view is destroyed", async () => {
    const { backend, manager, frame } = setup({ "/p/a.txt": "original\n" });
    const att = await attachDocument(manager, "/p/a.txt");
    const parent = document.createElement("div");
    const popup = document.createElement("button");
    popup.setAttribute("data-popup", "");
    const elsewhere = document.createElement("button");
    document.body.append(parent, popup, elsewhere);
    const view = new EditorView({ parent, doc: att.text(), extensions: [att.extension] });
    try {
      view.focus();
      view.dispatch({ changes: { from: 8, to: 9 } });
      popup.focus();
      await frame();
      view.destroy();
      elsewhere.focus();
      await frame();
      expect(backend.docs.get(att.doc)?.saved).toBe("original\n");
    } finally {
      view.destroy();
      att.release();
      manager.stop();
      parent.remove();
      popup.remove();
      elsewhere.remove();
    }
  });

  it("waits until focus leaves an editor popup before autosaving a diff", async () => {
    const { backend, manager, frame } = setup({ "/p/a.txt": "original\n" });
    const att = await attachDocument(manager, "/p/a.txt");
    const parent = document.createElement("div");
    const popup = document.createElement("div");
    popup.setAttribute("data-popup", "");
    const item = document.createElement("button");
    popup.append(item);
    const elsewhere = document.createElement("button");
    document.body.append(parent, popup, elsewhere);
    const view = new EditorView({ parent, doc: att.text(), extensions: [att.extension] });
    try {
      view.focus();
      view.dispatch({ changes: { from: 8, to: 9 } });
      item.focus();
      await frame();
      expect(backend.docs.get(att.doc)?.saved).toBe("original\n");
      view.focus();
      await frame();
      expect(att.dirty()).toBe(true);
      item.focus();
      await frame();
      elsewhere.focus();
      await frame();
      expect(backend.docs.get(att.doc)?.saved).toBe("original");
      expect(att.dirty()).toBe(false);
    } finally {
      view.destroy();
      att.release();
      manager.stop();
      parent.remove();
      popup.remove();
      elsewhere.remove();
    }
  });

  it("does not save another view's edits when leaving a read-only preview", async () => {
    const { backend, manager, frame } = setup({ "/p/a.txt": "original\n" });
    const model = await manager.acquire("/p/a.txt");
    const tab = new EditorSlot(model, "t1", host);
    const att = await attachDocument(manager, "/p/a.txt");
    const parent = document.createElement("div");
    const elsewhere = document.createElement("button");
    document.body.append(parent, elsewhere);
    const view = new EditorView({
      parent,
      doc: att.text(),
      extensions: [att.extension, EditorState.readOnly.of(true)],
    });
    try {
      tab.dispatchLocal({ changes: { from: 8, to: 9 } });
      view.focus();
      elsewhere.focus();
      await frame();
      expect(backend.docs.get(att.doc)?.saved).toBe("original\n");
      expect(att.dirty()).toBe(true);
    } finally {
      view.destroy();
      att.release();
      tab.dispose();
      manager.stop();
      parent.remove();
      elsewhere.remove();
    }
  });

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
