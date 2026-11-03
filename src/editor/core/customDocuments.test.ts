import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorController, useTabs } from "./controller";
import { createMemoryBackend } from "./backend";
import { findTab, initialTabsState, paneIds } from "./model/tabs";
import { useDocMeta } from "./model/document";
import { useProject } from "@/platform/project";
import { ask } from "@/workbench/messages";
import type * as Messages from "@/workbench/messages";
import * as virtualDocs from "@/platform/virtualDocs";
import type { VirtualDocument } from "@/platform/ipc";
import {
  registerEditorKind,
  registerFileEditorProvider,
  type EditorDocumentLifecycle,
  type EditorInput,
} from "@/workbench/contributions";

vi.mock("@/workbench/messages", async (original) => ({
  ...(await original<typeof Messages>()),
  ask: vi.fn(),
}));

class TestDocument implements EditorDocumentLifecycle {
  saved = "original";
  text = "edited";
  pending = "";
  running = false;
  frozen = false;
  closed = false;
  saves = 0;
  releases = 0;
  saveError: Error | null = null;
  prepareGate: Promise<void> | null = null;
  prepareError: Error | null = null;

  isDirty() {
    return this.text !== this.saved || this.pending !== "";
  }
  async flush() {
    this.text += this.pending;
    this.pending = "";
  }
  async save() {
    await this.flush();
    if (this.saveError) throw this.saveError;
    this.saves++;
    this.saved = this.text;
  }
  async prepareClose() {
    this.frozen = true;
    await this.flush();
    if (this.prepareGate) await this.prepareGate;
    if (this.running) this.text += "\nfinal output";
    this.running = false;
    if (this.prepareError) throw this.prepareError;
  }
  cancelClose() {
    this.frozen = false;
  }
  async discard() {
    this.pending = "";
    this.text = this.saved;
  }
  async close() {
    this.closed = true;
    this.running = false;
    this.releases++;
  }
}

const input = (name = "a"): EditorInput => ({
  kind: "lifecycle-test",
  key: `custom:${name}`,
  path: `/p/${name}.ipynb`,
});
let ctrl: EditorController;
let documents: Map<string, TestDocument>;
let unregister: () => void;

beforeEach(() => {
  useTabs.setState(initialTabsState(), true);
  useProject.setState({ project: null, settings: { files: { autoSave: false } } as never });
  localStorage.clear();
  documents = new Map();
  const sessions = documents;
  const lifecycle: EditorDocumentLifecycle = {
    isDirty: (i) => sessions.get(i.key)!.isDirty(),
    flush: (i) => sessions.get(i.key)!.flush(),
    save: (i) => sessions.get(i.key)!.save(),
    prepareClose: (i) => sessions.get(i.key)!.prepareClose(),
    cancelClose: (i) => sessions.get(i.key)!.cancelClose(),
    discard: (i) => sessions.get(i.key)!.discard(),
    close: (i) => sessions.get(i.key)!.close(),
  };
  unregister = registerEditorKind({
    kind: "lifecycle-test",
    component: () => null,
    title: (i) => i.key,
    document: lifecycle,
  });
  ctrl = new EditorController(createMemoryBackend());
  ctrl.start();
  vi.mocked(ask).mockReset();
  vi.mocked(ask).mockResolvedValue({ button: "cancel", checked: false });
});

afterEach(() => {
  ctrl.stop();
  unregister();
  useDocMeta.setState({}, true);
  useProject.setState({ project: null, settings: null });
  localStorage.clear();
});

async function open(name = "a") {
  const i = input(name);
  const doc = new TestDocument();
  documents.set(i.key, doc);
  await ctrl.openInput(i, { preview: true, focus: false });
  return doc;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("custom editor document lifetime", () => {
  it("rejects a delayed virtual document from the previous project", async () => {
    const started = deferred<void>();
    const response = deferred<VirtualDocument>();
    const probe = vi.spyOn(virtualDocs, "virtualDocument").mockImplementationOnce(() => {
      started.resolve();
      return response.promise;
    });
    try {
      const opening = ctrl.openVirtual("jdt://old/Class", { focus: false });
      await started.promise;
      useProject.setState({ project: { root: "/next", name: "next", settings: {} } as never });
      const rejected = expect(opening).rejects.toThrow("project changed");
      response.resolve({
        uri: "jdt://old/Class",
        text: "class Old {}",
        languageId: "java",
        title: "Class",
        description: null,
        decompiled: true,
      });
      await rejected;
      expect(findTab(useTabs.getState(), "virtual:jdt://old/Class")).toBeNull();
    } finally {
      probe.mockRestore();
    }
  });

  it.each(["pending", "cancelled", "replaced"] as const)(
    "rolls back delayed provider acquisition after a %s project close",
    async (route) => {
      const started = deferred<void>();
      const response = deferred<void>();
      let acquired = false;
      let installed = false;
      const dispose = registerFileEditorProvider({
        id: "delayed-lifecycle-test",
        order: -100,
        resolve: async (_path, context) => {
          started.resolve();
          await response.promise;
          acquired = true;
          context.onAdmission(
            () => {
              installed = true;
            },
            async () => {
              acquired = false;
            },
          );
          return input();
        },
      });
      try {
        const opening = ctrl.openFile(input().path!, { focus: false });
        await started.promise;
        const session = await ctrl.prepareClose();
        if (route === "cancelled") session.cancel();
        if (route === "replaced") {
          session.commit();
          useProject.setState({ project: { root: "/replacement", name: "replacement", settings: {} } as never });
        }
        const rejected = expect(opening).rejects.toThrow(route === "replaced" ? "project changed" : "closing");
        response.resolve();
        await rejected;
        session.cancel();
        expect(installed).toBe(false);
        expect(acquired).toBe(false);
        expect(findTab(useTabs.getState(), input().key)).toBeNull();
      } finally {
        dispose();
      }
    },
  );

  it("rejects a new open before invoking a provider while close admission is pending", async () => {
    let probes = 0;
    const tracked = registerFileEditorProvider({
      id: "tracked-probe",
      order: -101,
      resolve: () => {
        ++probes;
        return input();
      },
    });
    try {
      const closing = ctrl.prepareClose();
      await expect(ctrl.openFile(input().path!, { focus: false })).rejects.toThrow("closing");
      (await closing).cancel();
      expect(probes).toBe(0);
    } finally {
      tracked();
    }
  });

  it("retains pending changes and the last tab on Cancel", async () => {
    const doc = await open();
    doc.pending = " pending";
    await expect(ctrl.closeInput(input().key)).resolves.toBe(false);
    expect(findTab(useTabs.getState(), input().key)).not.toBeNull();
    expect(doc.text).toBe("edited pending");
    expect(doc.saved).toBe("original");
    expect(doc.frozen).toBe(false);
    expect(doc.closed).toBe(false);
  });

  it("saves a drained execution checkpoint before removing the last tab", async () => {
    const doc = await open();
    doc.running = true;
    vi.mocked(ask).mockResolvedValue({ button: "save", checked: false });
    await expect(ctrl.closePath(input().path!)).resolves.toBe(true);
    expect(doc.saved).toBe("edited\nfinal output");
    expect(doc.running).toBe(false);
    expect(doc.closed).toBe(true);
    expect(findTab(useTabs.getState(), input().key)).toBeNull();
  });

  it("discards without a removal-triggered autosave", async () => {
    const doc = await open();
    useProject.setState({ settings: { files: { autoSave: true } } as never });
    doc.pending = " unsaved";
    vi.mocked(ask).mockResolvedValue({ button: "discard", checked: false });
    await ctrl.closeEverything();
    expect(doc.saved).toBe("original");
    expect(doc.text).toBe("original");
    expect(doc.saves).toBe(0);
    expect(doc.closed).toBe(true);
  });

  it("keeps dirty state and tabs when save fails", async () => {
    const doc = await open();
    doc.saveError = new Error("external modification conflict");
    vi.mocked(ask).mockResolvedValue({ button: "save", checked: false });
    await expect(ctrl.closeActiveTab()).resolves.toBe(false);
    expect(findTab(useTabs.getState(), input().key)).not.toBeNull();
    expect(doc.isDirty()).toBe(true);
    expect(doc.frozen).toBe(false);
    expect(doc.closed).toBe(false);
  });

  it("closing one split neither prompts nor stops its shared execution", async () => {
    const doc = await open();
    doc.running = true;
    const first = useTabs.getState().activePane;
    ctrl.split(first, "row");
    await ctrl.unsplit(first);
    expect(doc.running).toBe(true);
    expect(doc.closed).toBe(false);
    expect(doc.frozen).toBe(false);
    expect(ask).not.toHaveBeenCalled();
    vi.mocked(ask).mockResolvedValue({ button: "discard", checked: false });
    await ctrl.closeInput(input().key);
    expect(doc.releases).toBe(1);
    expect(doc.running).toBe(false);
  });

  it("does not discard shared state when a split opens while a close prompt awaits", async () => {
    const doc = await open();
    const first = useTabs.getState().activePane;
    let answer!: (value: { button: string; checked: boolean }) => void;
    const asked = new Promise<void>((resolve) => {
      vi.mocked(ask).mockImplementationOnce(() => {
        resolve();
        return new Promise((r) => {
          answer = r;
        });
      });
    });
    const closing = ctrl.closeAll(first);
    await asked;
    ctrl.split(first, "row");
    answer({ button: "discard", checked: false });
    await closing;
    expect(paneIds(useTabs.getState())).toHaveLength(1);
    expect(findTab(useTabs.getState(), input().key)).not.toBeNull();
    expect(doc.text).toBe("edited");
    expect(doc.closed).toBe(false);
    expect(doc.frozen).toBe(false);
  });

  it("saves a split document once and reports failures after trying every document", async () => {
    const a = await open();
    ctrl.split(useTabs.getState().activePane, "row");
    const b = await open("b");
    a.saveError = new Error("disk full");
    await expect(ctrl.saveAll()).rejects.toThrow("disk full");
    expect(a.saved).toBe("original");
    expect(a.isDirty()).toBe(true);
    expect(b.saved).toBe("edited");
    a.saveError = null;
    await ctrl.saveAll();
    expect(a.saves).toBe(1);
    expect(b.saves).toBe(1);
  });

  it("never previews or evicts a dirty custom editor under LRU pressure", async () => {
    useProject.setState({
      settings: { files: { autoSave: false }, editor: { tabs: { tabLimit: 1, closingPolicy: "lru" } } } as never,
    });
    const doc = await open();
    await ctrl.openInput({ kind: "read-only-test", key: "other" }, { preview: true, focus: false });
    const tab = findTab(useTabs.getState(), input().key)?.tab;
    expect(tab?.preview).toBe(false);
    expect(doc.closed).toBe(false);
    expect(doc.text).toBe("edited");
    expect(findTab(useTabs.getState(), "other")).not.toBeNull();
  });

  it("Close Unmodified retains pending custom changes", async () => {
    const doc = await open();
    doc.text = doc.saved;
    doc.pending = "new typing";
    await ctrl.openInput({ kind: "read-only-test", key: "other" }, { focus: false });
    await ctrl.closeUnmodified(useTabs.getState().activePane);
    expect(findTab(useTabs.getState(), input().key)).not.toBeNull();
    expect(findTab(useTabs.getState(), "other")).toBeNull();
    expect(doc.pending).toBe("new typing");
  });

  it("Close Read-Only retains a dirty custom document on Cancel and releases it after Discard", async () => {
    const doc = await open();
    const pane = useTabs.getState().activePane;
    useDocMeta.setState({ [input().path!]: { readOnly: true } as never });
    const cancelled = await ctrl.closeReadOnly(pane);
    expect(findTab(useTabs.getState(), input().key)).not.toBeNull();
    expect(doc.text).toBe("edited");
    expect(doc.closed).toBe(false);
    expect(cancelled).toBe(false);

    vi.mocked(ask).mockResolvedValueOnce({ button: "discard", checked: false });
    expect(await ctrl.closeReadOnly(pane)).toBe(true);
    expect(findTab(useTabs.getState(), input().key)).toBeNull();
    expect(doc.saved).toBe("original");
    expect(doc.closed).toBe(true);
  });

  it("Unsplit All preserves cancelled documents and only releases their last removed view", async () => {
    const kept = await open();
    const keepPane = useTabs.getState().activePane;
    ctrl.split(keepPane, "row");
    const removedPane = useTabs.getState().activePane;
    const removed = await open("removed");

    const cancelled = await ctrl.unsplitAll(keepPane);
    expect(paneIds(useTabs.getState())).toContain(removedPane);
    expect(findTab(useTabs.getState(), input("removed").key)).not.toBeNull();
    expect(removed.text).toBe("edited");
    expect(removed.closed).toBe(false);
    expect(cancelled).toBe(false);

    vi.mocked(ask).mockResolvedValueOnce({ button: "discard", checked: false });
    expect(await ctrl.unsplitAll(keepPane)).toBe(true);
    expect(paneIds(useTabs.getState())).toEqual([keepPane]);
    expect(removed.saved).toBe("original");
    expect(removed.closed).toBe(true);
    expect(kept.text).toBe("edited");
    expect(kept.closed).toBe(false);
  });

  it("prepares hidden documents, deduplicates split state, and resumes after a failed project transition", async () => {
    const a = await open();
    ctrl.split(useTabs.getState().activePane, "row");
    const b = await open("b");
    b.running = true;
    const session = await ctrl.prepareClose();
    expect(session.dirty).toBe(2);
    expect(a.frozen).toBe(true);
    expect(b.running).toBe(false);
    await ctrl.saveAll();
    expect(b.saved).toBe("edited\nfinal output");
    session.commit();
    ctrl.cancelClose();
    expect(a.frozen).toBe(false);
    expect(b.frozen).toBe(false);
    expect(a.closed).toBe(false);
    expect(findTab(useTabs.getState(), input().key)).not.toBeNull();
  });

  it("project replacement releases old split documents once, without saving discarded changes", async () => {
    const doc = await open();
    ctrl.split(useTabs.getState().activePane, "row");
    const session = await ctrl.prepareClose();
    await session.discard();
    session.commit();
    useProject.setState({ project: { root: "/new-project", name: "new", settings: {} } as never });
    await ctrl.openInput({ kind: "read-only-test", key: "new-project-tab" }, { focus: false });
    expect(doc.saved).toBe("original");
    expect(doc.saves).toBe(0);
    expect(doc.releases).toBe(1);
    expect(findTab(useTabs.getState(), input().key)).toBeNull();
    expect(findTab(useTabs.getState(), "new-project-tab")).not.toBeNull();
  });

  it.each(["all", "others", "left", "right", "unsplit"] as const)(
    "%s respects a last-document Cancel without removing other tabs",
    async (route) => {
      const marker: EditorInput = { kind: "read-only-test", key: "marker" };
      if (route !== "left") await ctrl.openInput(marker, { focus: false });
      const doc = await open();
      const pane = useTabs.getState().activePane;
      if (route === "left") await ctrl.openInput(marker, { focus: false });
      if (route === "unsplit") await ctrl.openInput(marker, { side: true, focus: false });
      const markerTab = findTab(useTabs.getState(), marker.key)!.tab.id;
      let result: boolean;
      switch (route) {
        case "all":
          result = await ctrl.closeAll(pane);
          break;
        case "others":
          result = await ctrl.closeOthers(pane, markerTab);
          break;
        case "left":
          result = await ctrl.closeToLeft(pane, markerTab);
          break;
        case "right":
          result = await ctrl.closeToRight(pane, markerTab);
          break;
        case "unsplit":
          result = await ctrl.unsplit(pane);
          break;
      }
      expect(result).toBe(false);
      expect(findTab(useTabs.getState(), input().key)).not.toBeNull();
      expect(findTab(useTabs.getState(), marker.key)).not.toBeNull();
      expect(doc.text).toBe("edited");
      expect(doc.closed).toBe(false);
      expect(doc.frozen).toBe(false);
    },
  );

  it("keeps newly opened tabs when a bulk close completes", async () => {
    await open();
    let answer!: (value: { button: string; checked: boolean }) => void;
    let prompted!: () => void;
    const asked = new Promise<void>((resolve) => {
      prompted = resolve;
    });
    vi.mocked(ask).mockImplementationOnce(() => {
      prompted();
      return new Promise((resolve) => {
        answer = resolve;
      });
    });
    const closing = ctrl.closeEverything();
    await asked;
    const opening = ctrl.openInput({ kind: "read-only-test", key: "new-tab" }, { focus: false });
    await vi.waitFor(() => expect(findTab(useTabs.getState(), "new-tab")).not.toBeNull());
    answer({ button: "discard", checked: false });
    await Promise.all([closing, opening]);
    expect(findTab(useTabs.getState(), "new-tab")).not.toBeNull();
    expect(findTab(useTabs.getState(), input().key)).toBeNull();
  });

  it("does not prompt or blur-autosave a document until execution has drained", async () => {
    const doc = await open();
    useProject.setState({ settings: { files: { autoSave: true } } as never });
    let drain!: () => void;
    doc.prepareGate = new Promise<void>((resolve) => {
      drain = resolve;
    });
    doc.running = true;
    const closing = ctrl.closeInput(input().key);
    await vi.waitFor(() => expect(doc.frozen).toBe(true));
    window.dispatchEvent(new Event("blur"));
    expect(doc.saved).toBe("original");
    expect(ask).not.toHaveBeenCalled();
    drain();
    await closing;
    expect(doc.text).toBe("edited\nfinal output");
    expect(doc.saved).toBe("original");
    expect(doc.frozen).toBe(false);
    expect(doc.closed).toBe(false);
  });

  it("unfreezes every prepared document when another preparation fails", async () => {
    const a = await open();
    const b = await open("b");
    b.prepareError = new Error("pending source could not be flushed");
    await expect(ctrl.prepareClose()).rejects.toThrow("could not be flushed");
    expect(a.frozen).toBe(false);
    expect(b.frozen).toBe(false);
    expect(a.text).toBe("edited");
    expect(b.text).toBe("edited");
    expect(findTab(useTabs.getState(), input().key)).not.toBeNull();
    expect(findTab(useTabs.getState(), input("b").key)).not.toBeNull();
  });

  it("evicts a clean custom document through its last-reference lifecycle", async () => {
    useProject.setState({ settings: { files: { autoSave: false }, editor: { tabs: { tabLimit: 1 } } } as never });
    const doc = await open();
    doc.text = doc.saved;
    await ctrl.openInput({ kind: "read-only-test", key: "new-tab" }, { focus: false });
    expect(findTab(useTabs.getState(), input().key)).toBeNull();
    expect(findTab(useTabs.getState(), "new-tab")).not.toBeNull();
    expect(doc.releases).toBe(1);
    expect(doc.saved).toBe("original");
    expect(ask).not.toHaveBeenCalled();
  });

  it("releases old documents when a replacement project has the same root", async () => {
    useProject.setState({ project: { root: "/p", name: "first", settings: {} } as never });
    const doc = await open();
    const session = await ctrl.prepareClose();
    await session.discard();
    session.commit();
    useProject.setState({ opening: true });
    useProject.setState({ project: { root: "/p", name: "replacement", settings: {} } as never });
    useProject.setState({ opening: false });
    await ctrl.openInput({ kind: "read-only-test", key: "replacement-tab" }, { focus: false });
    expect(doc.releases).toBe(1);
    expect(findTab(useTabs.getState(), input().key)).toBeNull();
    expect(findTab(useTabs.getState(), "replacement-tab")).not.toBeNull();
  });

  it.each(["cancel", "save"] as const)(
    "does not apply an earlier bulk discard when a later %s aborts closing",
    async (button) => {
      const a = await open();
      const b = await open("b");
      b.saveError = new Error("disk full");
      vi.mocked(ask)
        .mockResolvedValueOnce({ button: "discard", checked: false })
        .mockResolvedValueOnce({ button, checked: false });
      await expect(ctrl.closeEverything()).resolves.toBe(false);
      expect(a.text).toBe("edited");
      expect(a.saved).toBe("original");
      expect(b.text).toBe("edited");
      expect(a.frozen).toBe(false);
      expect(b.frozen).toBe(false);
      expect(a.closed).toBe(false);
      expect(b.closed).toBe(false);
      expect(findTab(useTabs.getState(), input().key)).not.toBeNull();
      expect(findTab(useTabs.getState(), input("b").key)).not.toBeNull();
    },
  );

  it("guards a document that becomes the last split reference during another close prompt", async () => {
    const a = await open();
    const first = useTabs.getState().activePane;
    const firstTab = findTab(useTabs.getState(), input().key, first)!.tab.id;
    ctrl.split(first, "row");
    const second = useTabs.getState().activePane;
    const b = await open("b");
    await ctrl.openInput({ kind: "read-only-test", key: "marker" }, { focus: false });
    const marker = findTab(useTabs.getState(), "marker")!.tab.id;
    let answer!: (value: { button: string; checked: boolean }) => void;
    const asked = new Promise<void>((resolve) => {
      vi.mocked(ask).mockImplementationOnce(() => {
        resolve();
        return new Promise((r) => {
          answer = r;
        });
      });
    });
    const closing = ctrl.closeOthers(second, marker);
    await asked;
    // Moving onto the existing split merges its duplicate, leaving the
    // originally targeted tab as the only remaining reference.
    ctrl.moveTab(first, firstTab, second, 0);
    answer({ button: "discard", checked: false });
    await expect(closing).resolves.toBe(false);
    expect(a.text).toBe("edited");
    expect(b.text).toBe("edited");
    expect(a.closed).toBe(false);
    expect(b.closed).toBe(false);
    expect(a.frozen).toBe(false);
    expect(b.frozen).toBe(false);
    expect(findTab(useTabs.getState(), input().key)).not.toBeNull();
  });

  it("retains a tab that becomes dirty while a tab-limit close drains execution", async () => {
    useProject.setState({ settings: { files: { autoSave: false }, editor: { tabs: { tabLimit: 1 } } } as never });
    const doc = await open();
    doc.text = doc.saved;
    doc.running = true;
    let drain!: () => void;
    doc.prepareGate = new Promise<void>((resolve) => {
      drain = resolve;
    });
    const opening = ctrl.openInput({ kind: "read-only-test", key: "other" }, { focus: false });
    await vi.waitFor(() => expect(doc.frozen).toBe(true));
    drain();
    await opening;
    expect(doc.text).toBe("original\nfinal output");
    expect(doc.saved).toBe("original");
    expect(doc.closed).toBe(false);
    expect(doc.frozen).toBe(false);
    expect(findTab(useTabs.getState(), input().key)).not.toBeNull();
    expect(ask).not.toHaveBeenCalled();
  });

  it("attempts remaining saves when a lifecycle callback throws synchronously", async () => {
    const a = await open();
    const b = await open("b");
    a.save = () => {
      throw new Error("session unavailable");
    };
    await expect(ctrl.saveAll()).rejects.toThrow("session unavailable");
    expect(a.saved).toBe("original");
    expect(a.text).toBe("edited");
    expect(b.saved).toBe("edited");
  });

  it("rejects authorization from a cancelled project close session", async () => {
    const doc = await open();
    const session = await ctrl.prepareClose();
    session.cancel();
    expect(() => session.commit()).toThrow();
    expect(doc.frozen).toBe(false);
    expect(doc.text).toBe("edited");
    expect(findTab(useTabs.getState(), input().key)).not.toBeNull();
  });

  it("does not return an authorized session after preparation was cancelled in flight", async () => {
    const doc = await open();
    let drain!: () => void;
    doc.prepareGate = new Promise<void>((resolve) => {
      drain = resolve;
    });
    const preparing = ctrl.prepareClose();
    await vi.waitFor(() => expect(doc.frozen).toBe(true));
    ctrl.cancelClose();
    drain();
    await expect(preparing).rejects.toThrow("cancelled");
    expect(doc.frozen).toBe(false);
    expect(doc.text).toBe("edited");
    expect(doc.closed).toBe(false);
    expect(findTab(useTabs.getState(), input().key)).not.toBeNull();
  });
});
