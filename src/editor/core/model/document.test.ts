import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { remoteChange } from "@/editor/api";
import { createMemoryBackend, type MemoryBackend } from "../backend";
import { _resetLanguages } from "../cm/languages";
import { DocumentManager, ModifiedRanges, saveCleanupChanges, useDocMeta } from "./document";
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

function setup(files: Record<string, string>, settings = {}) {
  _resetLanguages();
  const backend: MemoryBackend = createMemoryBackend(files);
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

describe("DocumentManager + slots", () => {
  it("shares one document between split slots and syncs edits to the backend", async () => {
    const { backend, manager, frame } = setup({ "/p/a.txt": "hello\n" });
    const model = await manager.acquire("/p/a.txt");
    expect(await manager.acquire("/p/a.txt")).toBe(model);
    const left = new EditorSlot(model, "t1", host);
    const right = new EditorSlot(model, "t2", host, { from: left });
    left.dispatchLocal({ changes: { from: 5, insert: " world" } });
    expect(right.currentState().doc.toString()).toBe("hello world\n");
    expect(useDocMeta.getState()["/p/a.txt"]?.dirty).toBe(true);
    await frame();
    expect(backend.docs.get(model.doc)?.text).toBe("hello world\n");
    // Undo history stays per slot: the mirrored change is not undoable on the right.
    right.dispatchLocal({ changes: { from: 0, insert: ">" } });
    await frame();
    expect(left.currentState().doc.toString()).toBe(">hello world\n");
    expect(backend.docs.get(model.doc)?.text).toBe(">hello world\n");
  });

  it("applies backend patches to every slot, annotated as remote", async () => {
    const { backend, manager, frame } = setup({ "/p/a.txt": "abc" });
    const model = await manager.acquire("/p/a.txt");
    const a = new EditorSlot(model, "t1", host);
    const b = new EditorSlot(model, "t2", host);
    let sawRemote = false;
    const spy = vi.spyOn(a, "applyExternal").mockImplementation(function (this: EditorSlot, changes, annotations) {
      sawRemote = annotations.some((x) => x.type === remoteChange);
      this.state = this.state.update({ changes, annotations }).state;
    });
    backend.patch(model.doc, [{ from: 3, to: 3, insert: "def" }]);
    expect(sawRemote).toBe(true);
    expect(a.currentState().doc.toString()).toBe("abcdef");
    expect(b.currentState().doc.toString()).toBe("abcdef");
    spy.mockRestore();
    // A local edit after the patch uses the new base version.
    b.dispatchLocal({ changes: { from: 0, insert: "0" } });
    await frame();
    expect(backend.docs.get(model.doc)?.text).toBe("0abcdef");
  });

  it("trims modified lines and adds the final newline on save", async () => {
    const { backend, manager, frame } = setup({ "/p/a.txt": "keep   \nline" });
    const model = await manager.acquire("/p/a.txt");
    const slot = new EditorSlot(model, "t1", host);
    slot.dispatchLocal({ changes: { from: 12, insert: " x   " } });
    const save = model.save("explicit");
    await frame();
    await save;
    expect(backend.files.get("/p/a.txt")).toBe("keep   \nline x\n");
    expect(useDocMeta.getState()["/p/a.txt"]?.dirty).toBe(false);
  });

  it("closes the backend document when the last slot goes away", async () => {
    const { backend, manager } = setup({ "/p/a.txt": "x" });
    const model = await manager.acquire("/p/a.txt");
    const a = new EditorSlot(model, "t1", host);
    const b = new EditorSlot(model, "t2", host);
    a.dispose();
    await settle();
    expect(backend.docs.size).toBe(1);
    b.dispose();
    await settle();
    expect(backend.docs.size).toBe(0);
    expect(manager.get("/p/a.txt")).toBeUndefined();
  });

  it("Save All rejects a failed document save after saving the remaining dirty documents", async () => {
    const { backend, manager } = setup({ "/p/a.txt": "a\n", "/p/b.txt": "b\n" }, { files: { autoSave: false } });
    try {
      const a = await manager.acquire("/p/a.txt");
      const b = await manager.acquire("/p/b.txt");
      backend.patch(a.doc, [{ from: 0, to: 0, insert: "changed " }]);
      backend.patch(b.doc, [{ from: 0, to: 0, insert: "changed " }]);
      const save = backend.save.bind(backend);
      vi.spyOn(backend, "save").mockImplementation(async (id) => {
        if (id === a.doc) throw new Error("disk full");
        await save(id);
      });
      await expect(manager.saveAll("explicit")).rejects.toThrow("disk full");
      expect(backend.files.get("/p/a.txt")).toBe("a\n");
      expect(backend.files.get("/p/b.txt")).toBe("changed b\n");
      expect(a.getMeta().dirty).toBe(true);
      expect(b.getMeta().dirty).toBe(false);
    } finally {
      manager.stop();
    }
  });
});

describe("save cleanup", () => {
  it("keeps the caret line and untouched lines", () => {
    const state = EditorState.create({ doc: "a  \nb  \nc  " });
    const m = new ModifiedRanges();
    m.ranges = [
      [0, 3],
      [8, 11],
    ];
    const changes = saveCleanupChanges(state, m, { trim: true, finalNewline: true, protectLines: new Set([3]) });
    expect(changes).toEqual([
      { from: 1, to: 3 },
      { from: 11, to: 11, insert: "\n" },
    ]);
  });
});
