import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { indentUnit, language as languageFacet } from "@codemirror/language";
import { HEAVY_LIMIT, onEditorEvent, registerSaveParticipant, remoteChange, shownAgain } from "@/editor/api";
import { createMemoryBackend, type MemoryBackend } from "../backend";
import { _resetLanguages } from "../cm/languages";
import { DocumentManager, ModifiedRanges, saveCleanupChanges, useDocMeta } from "./document";
import { EditorSlot, type SlotHost } from "./slot";
import { formatOptionsOf } from "@/editor/lsp/format";

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
  it("emits a versioned document change from a real local edit", async () => {
    const { manager, frame } = setup({ "/p/a.txt": "abc" });
    const model = await manager.acquire("/p/a.txt");
    const slot = new EditorSlot(model, "t1", host);
    const events: unknown[] = [];
    const off = onEditorEvent((event) => {
      if (event.type === "docChanged") events.push(event);
    });
    try {
      slot.dispatchLocal({ changes: { from: 1, to: 2, insert: "XYZ" }, userEvent: "input.type" });
      await frame();
      expect(events).toEqual([
        {
          type: "docChanged",
          doc: model.doc,
          path: "/p/a.txt",
          baseVersion: 0,
          version: 1,
          changes: [{ from: 1, to: 2, insert: "XYZ" }],
        },
      ]);
    } finally {
      off();
      manager.stop();
    }
  });

  it("requests Kotlin declaration highlights while retaining its CodeMirror language", async () => {
    const { backend, manager, frame } = setup({ "/p/Palette.kt": "class Greeter { fun greet() {} }" });
    const highlights = vi.spyOn(backend, "highlights").mockResolvedValue({ kinds: ["function"], data: [20, 25, 0] });
    const model = await manager.acquire("/p/Palette.kt");
    await frame();
    expect(model.language).not.toBeNull();
    expect(model.getMeta().language).toBe("kotlin");
    await vi.waitFor(() => expect(highlights).toHaveBeenCalledWith(model.doc));
    manager.stop();
  });

  it.each([
    ["Palette.kt", "fun greet() {}", 1],
    ["demo.py", "def greet(): pass", 0],
    ["demo.ex", "defmodule Demo do\nend", 1],
    ["Large.kt", " ".repeat(HEAVY_LIMIT + 1), 1],
  ])("debounces backend highlights after an edit burst in %s", async (name, text, requests) => {
    const { backend, manager, frame } = setup({ [`/p/${name}`]: text });
    const highlights = vi.spyOn(backend, "highlights");
    try {
      const model = await manager.acquire(`/p/${name}`);
      const slot = new EditorSlot(model, name, host);
      await frame();
      expect(highlights).toHaveBeenCalledTimes(requests);
      highlights.mockClear();
      for (let i = 0; i < 5; i++) slot.dispatchLocal({ changes: { from: 0, insert: " " } });
      await frame();
      expect(highlights).not.toHaveBeenCalled();
      await new Promise((resolve) => setTimeout(resolve, 550));
      expect(highlights).toHaveBeenCalledTimes(requests);
    } finally {
      manager.stop();
    }
  });

  it("gives a new slot the Code Style indent for Reformat Code, not the detected one", async () => {
    const settings = {
      editor: {
        codeStyle: {
          languages: { java: { useTab: true, tabSize: 1, indent: 1 } },
          detectIndents: true,
          editorconfig: false,
        },
      },
    };
    const { manager } = setup({ "/p/A.java": "class A {\n    int x;\n}\n" }, settings);
    const model = await manager.acquire("/p/A.java");
    const first = new EditorSlot(model, "t1", host);
    const split = new EditorSlot(model, "t2", host, { from: first });
    for (const slot of [first, split])
      expect(formatOptionsOf(slot.currentState())).toEqual({ tabSize: 1, insertSpaces: false });
  });

  it("reformats with the Code Style indent also without a language override (#2467)", async () => {
    const settings = { editor: { codeStyle: { languages: {}, detectIndents: true, editorconfig: false } } };
    const { manager } = setup({ "/p/A.java": "class A {\n  int x;\n}\n" }, settings);
    const model = await manager.acquire("/p/A.java");
    const slot = new EditorSlot(model, "t1", host);
    // Editing follows the 2-space indent detected in the file; Reformat Code uses Java's 4.
    expect(slot.currentState().facet(indentUnit)).toBe("  ");
    expect(formatOptionsOf(slot.currentState())).toEqual({ tabSize: 4, insertSpaces: true });
  });

  it("detects the indents again after Reformat Code rewrote them", async () => {
    const settings = {
      editor: {
        codeStyle: {
          languages: { java: { useTab: true, tabSize: 1, indent: 1 } },
          detectIndents: true,
          editorconfig: false,
        },
      },
    };
    const { manager } = setup({ "/p/A.java": "class A {\n    int x;\n}\n" }, settings);
    const model = await manager.acquire("/p/A.java");
    const first = new EditorSlot(model, "t1", host);
    const split = new EditorSlot(model, "t2", host, { from: first });
    expect(first.currentState().tabSize).toBe(4);
    // Typing keeps the indents detected when the file was opened.
    first.dispatchLocal({ changes: { from: 10, to: 14, insert: "\t" }, userEvent: "input.type" });
    expect(first.currentState().tabSize).toBe(4);
    first.dispatchLocal({ changes: { from: 10, to: 11, insert: "    " }, userEvent: "undo" });
    first.dispatchLocal({ changes: { from: 10, to: 14, insert: "\t" }, userEvent: "format.reformat" });
    for (const slot of [first, split]) {
      expect(slot.currentState().tabSize).toBe(1);
      expect(slot.currentState().facet(indentUnit)).toBe("\t");
    }
    expect(useDocMeta.getState()["/p/A.java"]?.indent).toEqual({ tabSize: 1, insertSpaces: false });
  });

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
    const applyExternal = a.applyExternal.bind(a);
    const spy = vi.spyOn(a, "applyExternal").mockImplementation((changes, annotations) => {
      sawRemote = annotations.some((x) => x.type === remoteChange);
      applyExternal(changes, annotations);
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

  it.each(["explicit", "auto"] as const)(
    "%s save leaves untouched documents byte-for-byte unchanged",
    async (reason) => {
      const files = {
        "/p/src/main/resources/sql/no-final.sql": "SELECT *\nFROM patients\n\tLIMIT 10 OFFSET 0",
        "/p/trailing.sql": "SELECT id   \nFROM patients;\t \n",
        "/p/crlf.sql": "SELECT id\r\nFROM patients;\r\n",
        "/p/Untouched.java": "class Untouched {   \n\tint id;\n}",
        "/p/blank.sql": "SELECT 1;\n\n\n",
        "/p/edited.java": "class Edited {}\n",
      };
      const { backend, manager } = setup(files, {
        editor: { general: { stripTrailingScope: "all", removeTrailingBlankLines: true } },
      });
      const participant = vi.fn();
      const unregister = registerSaveParticipant({ id: "test.save", beforeSave: participant });
      const save = vi.spyOn(backend, "save");
      try {
        const slots = [];
        for (const path of Object.keys(files)) slots.push(new EditorSlot(await manager.acquire(path), path, host));
        const edited = slots.at(-1)!;
        edited.dispatchLocal({ changes: { from: 0, insert: "// edited\n" } });
        await manager.saveAll(reason);
        for (const [path, text] of Object.entries(files)) {
          if (path !== "/p/edited.java") expect(backend.files.get(path), path).toBe(text);
        }
        expect(backend.files.get("/p/edited.java")).toBe("// edited\nclass Edited {}\n");
        expect(save.mock.calls).toEqual([[edited.model.doc]]);
        expect(participant).toHaveBeenCalledTimes(reason === "explicit" ? 1 : 0);
        if (reason === "explicit") expect(participant.mock.calls[0]![0].path).toBe("/p/edited.java");
        await manager.saveAll(reason);
        expect(save).toHaveBeenCalledTimes(1);
      } finally {
        unregister();
        manager.stop();
      }
    },
  );

  it("checks dirty state when each queued save starts", async () => {
    const { backend, manager } = setup({ "/p/query.sql": "SELECT 1" });
    const model = await manager.acquire("/p/query.sql");
    const slot = new EditorSlot(model, "t1", host);
    slot.dispatchLocal({ changes: { from: 7, to: 8, insert: "2" } });
    const save = vi.spyOn(backend, "save");
    try {
      await Promise.all([model.save("explicit"), model.save("explicit"), model.save("auto")]);
      expect(backend.files.get(model.path)).toBe("SELECT 2\n");
      expect(save).toHaveBeenCalledTimes(1);
    } finally {
      manager.stop();
    }
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

  it("loads the document's own mode over its language's (Angular templates)", async () => {
    const { manager } = setup({ "/p/angular.json": "{}", "/p/src/app.html": '<p [title]="name()"></p>' });
    const model = await manager.acquire("/p/src/app.html");
    expect(model.getMeta().uiMode).toBe("Angular Template");
    await model.loadLanguage();
    const slot = new EditorSlot(model, "t1", host);
    expect(slot.currentState().facet(languageFacet)?.name).toBe("angular");
  });

  it("takes the document's mode from a language change", async () => {
    const { manager } = setup({ "/p/app.txt": "<p></p>" });
    const model = await manager.acquire("/p/app.txt");
    model.setLanguage("html", "Angular Template");
    expect(model.getMeta().uiMode).toBe("Angular Template");
  });

  it("follows a change of the document's mode alone", async () => {
    const { manager } = setup({ "/p/app.html": "<p></p>" });
    const model = await manager.acquire("/p/app.html");
    const slot = new EditorSlot(model, "t1", host);
    model.setLanguage("html", "Angular Template");
    await model.loadLanguage();
    expect(model.getMeta().uiMode).toBe("Angular Template");
    expect(slot.currentState().facet(languageFacet)?.name).toBe("angular");
    model.setLanguage("html", null);
    expect(model.getMeta().uiMode).not.toBe("Angular Template");
    expect(slot.currentState().facet(languageFacet)?.name).not.toBe("angular");
  });

  it.each(["ts", "mts", "cts"])("loads Angular inline templates for .%s documents", async (ext) => {
    const path = `/p/src/app.${ext}`;
    const { manager } = setup({
      "/p/angular.json": "{}",
      [path]: "@Component({ template: `<r-card/>` }) class App {}",
    });
    const model = await manager.acquire(path);
    const slot = new EditorSlot(model, "t1", host);
    expect(model.getMeta()).toMatchObject({ language: "typescript", uiMode: "Angular TypeScript" });
    expect(slot.currentState().facet(languageFacet)?.name).toBe("angular-typescript");
    slot.dispose();
    manager.stop();
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

  it("keeps a hidden tab's view and shows it again instead of building a new one", async () => {
    const { backend, manager } = setup({ "/p/a.txt": "abc" });
    const model = await manager.acquire("/p/a.txt");
    const slot = new EditorSlot(model, "t1", host);
    const shown: boolean[] = [];
    slot.listeners.add((u) => shown.push(shownAgain(u)));
    const view = slot.mount(document.body);
    slot.unmount();
    expect(slot.view).toBeNull();
    expect(view.dom.isConnected).toBe(false);
    // Changes while hidden go to the kept view.
    backend.patch(model.doc, [{ from: 3, to: 3, insert: "def" }]);
    expect(view.state.doc.toString()).toBe("abcdef");
    expect(slot.currentState()).toBe(view.state);
    shown.length = 0;
    expect(slot.mount(document.body)).toBe(view);
    expect(view.dom.isConnected).toBe(true);
    expect(shown).toContain(true);
    slot.dispose();
    manager.stop();
  });

  it("destroys the least recently hidden views beyond the kept ones, and kept views on dispose", async () => {
    const { manager } = setup({ "/p/a.txt": "abc" });
    const model = await manager.acquire("/p/a.txt");
    const slots = Array.from({ length: 8 }, (_, i) => new EditorSlot(model, `t${i}`, host));
    const views = slots.map((slot) => {
      const view = slot.mount(document.body);
      slot.unmount();
      return view;
    });
    const destroyed = views.map((view) => vi.spyOn(view, "destroy"));
    slots.push(new EditorSlot(model, "t8", host));
    slots[8]!.mount(document.body);
    slots[8]!.unmount();
    expect(destroyed[0]).toHaveBeenCalled();
    expect(destroyed[1]).not.toHaveBeenCalled();
    // A destroyed view leaves its state behind; showing the tab builds a new view on it.
    expect(slots[0]!.mount(document.body)).not.toBe(views[0]);
    slots[1]!.dispose();
    expect(destroyed[1]).toHaveBeenCalled();
    for (const slot of slots) slot.dispose();
    manager.stop();
  });

  it("restores a destroyed kept view at its exact scroll offset, not its top line", async () => {
    const { manager } = setup({ "/p/a.txt": "line\n".repeat(500) });
    const model = await manager.acquire("/p/a.txt");
    const slot = new EditorSlot(model, "t0", host);
    const view = slot.mount(document.body);
    Object.defineProperty(view.scrollDOM, "scrollTop", { value: 137, configurable: true });
    view.scrollDOM.dispatchEvent(new Event("scroll"));
    slot.unmount();
    const expected = view.scrollSnapshot().value as { range: unknown; yMargin: number; isSnapshot: boolean };
    const others = Array.from({ length: 8 }, (_, i) => new EditorSlot(model, `t${i + 1}`, host));
    for (const other of others) {
      other.mount(document.body);
      other.unmount();
    }
    const restored = (slot as unknown as { scroll: { value: typeof expected } }).scroll.value;
    expect(restored.isSnapshot).toBe(true);
    expect(restored.range).toEqual(expected.range);
    expect(restored.yMargin).toBe(expected.yMargin);
    for (const s of [slot, ...others]) s.dispose();
    manager.stop();
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
