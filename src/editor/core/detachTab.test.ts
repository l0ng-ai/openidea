import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorSelection } from "@codemirror/state";
import { EditorController, useTabs } from "./controller";
import { createMemoryBackend } from "./backend";
import { initialTabsState } from "./model/tabs";
import { useProject } from "@/platform/project";
import { commands } from "@/platform/ipc";
import { prepareEditorWindow, updateEditorHandoff, type EditorTransfer } from "@/platform/editorTransfer";
import * as contributions from "@/workbench/contributions";
import { ask } from "@/workbench/messages";
import type * as Messages from "@/workbench/messages";
import { registerEditorKind, type EditorDocumentLifecycle } from "@/workbench/contributions";

vi.mock("@/workbench/messages", async (original) => ({
  ...(await original<typeof Messages>()),
  ask: vi.fn(),
}));
vi.mock("@tauri-apps/api/window", async (original) => ({
  ...(await original<typeof import("@tauri-apps/api/window")>()),
  getCurrentWindow: () => ({ label: "main" }),
}));
vi.mock("@/platform/editorTransfer", async (original) => ({
  ...(await original<typeof import("@/platform/editorTransfer")>()),
  prepareEditorWindow: vi.fn(),
}));

const notify = vi.fn();
const commit = vi.fn(async () => {});
const finish = vi.fn(async () => {});
const rollback = vi.fn(async () => {});
const handoff = { commit, finish, rollback };
let ctrl: EditorController;
let unregister: (() => void) | undefined;
const path = "/p/a.ts";
const current = () => {
  const state = useTabs.getState();
  return [state.activePane, state.panes[state.activePane]!.active!] as const;
};
const hasTab = (id: string) =>
  Object.values(useTabs.getState().panes).some((pane) => pane.tabs.some((tab) => tab.id === id));

beforeEach(() => {
  notify.mockReset();
  commit.mockReset().mockResolvedValue(undefined);
  finish.mockReset().mockResolvedValue(undefined);
  rollback.mockReset().mockResolvedValue(undefined);
  vi.mocked(prepareEditorWindow).mockReset().mockResolvedValue(handoff);
  vi.spyOn(contributions, "notifications").mockReturnValue({ notify });
  vi.spyOn(commands, "windowOpenFileInNewWindow");
  useTabs.setState(initialTabsState(), true);
  useProject.setState({ project: null, settings: { files: { autoSave: false } } as never });
});

afterEach(async () => {
  await ctrl?.stop();
  await ctrl?.manager.whenReleased();
  unregister?.();
  unregister = undefined;
  vi.restoreAllMocks();
  vi.mocked(ask).mockReset();
  useProject.setState({ project: null, settings: null });
});

describe("detachTab", () => {
  it("recovers the recorded handoff after a lost finish reply", async () => {
    const advance = vi
      .spyOn(commands, "windowEditorHandoff")
      .mockRejectedValueOnce(new Error("reply lost"))
      .mockResolvedValueOnce({ status: "ok", data: "finished" });

    expect(await updateEditorHandoff("transfer", "finish")).toBe("finished");
    expect(advance.mock.calls).toEqual([
      ["transfer", "finish"],
      ["transfer", "finish"],
    ]);
  });

  it.each(["tab", "window"])("keeps shared custom edits out of the %s close decision", async (close) => {
    const discard = vi.fn(async () => {});
    unregister = registerEditorKind({
      kind: "shared-close",
      title: () => "shared",
      component: () => null,
      document: {
        isDirty: () => true,
        flush: async () => {},
        prepareClose: async () => false,
        cancelClose: () => {},
        save: async () => {},
        discard,
        close: async () => {},
      },
    });
    ctrl = new EditorController(createMemoryBackend());
    ctrl.start();
    await ctrl.openInput({ kind: "shared-close", key: "shared", path: "/p/a.ipynb" }, { focus: false });
    if (close === "tab") expect(await ctrl.closeTab(...current())).toBe(true);
    else {
      const session = await ctrl.prepareClose();
      expect(session.dirty).toBe(0);
      await session.discard();
      session.commit();
      await ctrl.finishWindowClose();
    }
    expect(ctrl.openTabs()).toHaveLength(0);
    expect(ask).not.toHaveBeenCalled();
    expect(discard).not.toHaveBeenCalled();
  });

  it.each([false, true])("hands off unsaved text before removing the source, autosave=%s", async (autoSave) => {
    useProject.setState({ settings: { files: { autoSave } } as never });
    const backend = createMemoryBackend({ [path]: "original\n" });
    ctrl = new EditorController(backend);
    ctrl.start();
    await ctrl.openFile(path, { focus: false });
    const [pane, id] = current();
    ctrl.slotFor(id)!.dispatchLocal({ changes: { from: 0, to: 8, insert: "edited" }, selection: { anchor: 2 } });
    const save = vi.spyOn(backend, "save");
    let acknowledge!: () => void;
    commit.mockImplementation(() => new Promise<void>((resolve) => (acknowledge = resolve)));

    const result = ctrl.detachTab(pane, id);
    await vi.waitFor(() => expect(commit).toHaveBeenCalledOnce());
    expect(hasTab(id)).toBe(true);
    expect(await ctrl.detachTab(pane, id)).toBe(false);
    expect(prepareEditorWindow).toHaveBeenCalledOnce();
    expect(prepareEditorWindow).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "main",
        tab: { input: expect.objectContaining({ kind: "file", path }), pinned: false },
        document: expect.objectContaining({
          state: expect.objectContaining({ doc: "edited\n" }),
          view: expect.objectContaining({ anchor: 2, head: 2 }),
        }),
      }),
      null,
    );
    acknowledge();
    expect(await result).toBe(true);
    expect(hasTab(id)).toBe(false);
    await ctrl.manager.whenReleased();
    expect(save).not.toHaveBeenCalled();
    expect(backend.files.get(path)).toBe("original\n");
    expect(finish).toHaveBeenCalledOnce();
    expect(rollback).not.toHaveBeenCalled();
    expect(commands.windowOpenFileInNewWindow).not.toHaveBeenCalled();
    expect(ask).not.toHaveBeenCalled();
  });

  it.each(["prepare", "commit"])("keeps the dirty pinned source when %s fails", async (stage) => {
    const backend = createMemoryBackend({ [path]: "original\n" });
    ctrl = new EditorController(backend);
    ctrl.start();
    await ctrl.openFile(path, { focus: false });
    const [pane, id] = current();
    ctrl.togglePin(pane, id);
    ctrl.slotFor(id)!.dispatchLocal({ changes: { from: 0, to: 8, insert: "edited" } });
    if (stage === "prepare") vi.mocked(prepareEditorWindow).mockRejectedValue(new Error("window failed"));
    else commit.mockRejectedValue(new Error("window failed"));

    expect(await ctrl.detachTab(pane, id)).toBe(false);
    expect(hasTab(id)).toBe(true);
    expect(useTabs.getState().panes[pane]!.tabs.find((tab) => tab.id === id)?.pinned).toBe(true);
    expect(ctrl.slotFor(id)!.currentState().doc.toString()).toBe("edited\n");
    expect(backend.files.get(path)).toBe("original\n");
    expect(rollback).toHaveBeenCalledTimes(stage === "commit" ? 1 : 0);
    expect(finish).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ level: "error", body: "window failed" }));
  });

  it("removes the source from its current split when the handoff completes", async () => {
    const other = "/p/other.ts";
    ctrl = new EditorController(createMemoryBackend({ [path]: "original\n", [other]: "other\n" }));
    ctrl.start();
    await ctrl.openFile(path, { focus: false });
    const [pane, id] = current();
    await ctrl.openFilesIn([other], pane, "right");
    let acknowledge!: () => void;
    commit.mockImplementation(() => new Promise<void>((resolve) => (acknowledge = resolve)));
    const result = ctrl.detachTab(pane, id);
    await vi.waitFor(() => expect(commit).toHaveBeenCalledOnce());
    ctrl.moveToOpposite(pane, id);
    expect(hasTab(id)).toBe(true);
    expect(useTabs.getState().panes[pane]).toBeUndefined();
    acknowledge();
    expect(await result).toBe(true);
    expect(hasTab(id)).toBe(false);
  });

  it("does not start a transfer when the source document cannot load", async () => {
    const backend = createMemoryBackend({ [path]: "original\n" });
    vi.spyOn(backend, "open").mockRejectedValue(new Error("File unavailable"));
    ctrl = new EditorController(backend);
    ctrl.start();
    await ctrl.openFile(path, { focus: false });
    const [pane, id] = current();

    expect(await ctrl.detachTab(pane, id)).toBe(false);
    expect(hasTab(id)).toBe(true);
    expect(prepareEditorWindow).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ body: "File unavailable" }));
  });

  it("rejects adoption when the target document cannot load", async () => {
    const backend = createMemoryBackend();
    vi.spyOn(backend, "open").mockRejectedValue(new Error("Disk unavailable"));
    ctrl = new EditorController(backend);
    ctrl.start({ persistSession: false });
    const transfer: EditorTransfer = {
      id: "failed-transfer",
      source: "main",
      project: null,
      tab: { input: { kind: "file", key: `file:${path}`, path }, pinned: false },
      libraries: [],
    };

    await expect(ctrl.adoptTransfer(transfer)).rejects.toThrow("Disk unavailable");
    expect(ctrl.slotFor(current()[1])).toBeNull();
  });

  it.each([false, true])("restores selection safely, document changed=%s", async (changed) => {
    const backend = createMemoryBackend({ [path]: "abcdef\n" });
    ctrl = new EditorController(backend);
    ctrl.start({ persistSession: false });
    await ctrl.openFile(path, { focus: false });
    const slot = ctrl.slotFor(current()[1])!;
    const selection = EditorSelection.create([EditorSelection.range(0, 1), EditorSelection.range(4, 6)], 1);
    slot.dispatchLocal({ selection });
    const document = slot.captureTransfer();
    await ctrl.stop();
    await ctrl.manager.whenReleased();
    if (changed) backend.files.set(path, "x\n");

    ctrl = new EditorController(backend);
    ctrl.start({ persistSession: false });
    await ctrl.adoptTransfer({
      id: "selection-transfer",
      source: "main",
      project: null,
      tab: { input: { kind: "file", key: `file:${path}`, path }, pinned: false },
      document,
      libraries: [],
    });
    const restored = ctrl.slotFor(current()[1])!.currentState().selection;
    expect(restored.toJSON()).toEqual((changed ? EditorSelection.single(2) : selection).toJSON());
  });

  it("moves a custom document without saving, discarding or closing its project resource", async () => {
    const lifecycle: EditorDocumentLifecycle = {
      isDirty: () => true,
      flush: vi.fn(async () => {}),
      prepareClose: vi.fn(async () => {}),
      cancelClose: vi.fn(),
      save: vi.fn(async () => {}),
      discard: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    };
    const feature = { selectedCell: "cell-1" };
    const transfer = {
      capture: vi.fn(async () => feature),
      adopt: vi.fn(async () => {}),
      release: vi.fn(async () => {}),
    };
    unregister = registerEditorKind({
      kind: "detach-test",
      title: () => "test",
      component: () => null,
      document: lifecycle,
      transfer,
    });
    ctrl = new EditorController(createMemoryBackend());
    ctrl.start();
    await ctrl.openInput({ kind: "detach-test", key: "custom", path: "/p/a.ipynb" }, { focus: false });
    const [pane, id] = current();

    expect(await ctrl.detachTab(pane, id)).toBe(true);
    expect(hasTab(id)).toBe(false);
    expect(lifecycle.flush).toHaveBeenCalledOnce();
    expect(transfer.capture).toHaveBeenCalledOnce();
    expect(prepareEditorWindow).toHaveBeenCalledWith(expect.objectContaining({ feature }), null);
    expect(transfer.release).toHaveBeenCalledOnce();
    expect(lifecycle.prepareClose).not.toHaveBeenCalled();
    expect(lifecycle.save).not.toHaveBeenCalled();
    expect(lifecycle.discard).not.toHaveBeenCalled();
    expect(lifecycle.close).not.toHaveBeenCalled();
    expect(ask).not.toHaveBeenCalled();
  });

  it("keeps a custom document when flushing fails", async () => {
    unregister = registerEditorKind({
      kind: "detach-test",
      title: () => "test",
      component: () => null,
      document: {
        isDirty: () => true,
        flush: async () => {
          throw new Error("flush failed");
        },
        prepareClose: async () => {},
        cancelClose: () => {},
        save: async () => {},
        discard: async () => {},
        close: async () => {},
      },
    });
    ctrl = new EditorController(createMemoryBackend());
    ctrl.start();
    await ctrl.openInput({ kind: "detach-test", key: "custom", path: "/p/a.ipynb" }, { focus: false });
    const [pane, id] = current();

    expect(await ctrl.detachTab(pane, id)).toBe(false);
    expect(hasTab(id)).toBe(true);
    expect(prepareEditorWindow).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ body: "flush failed" }));
  });

  it("leaves unsupported editor kinds in their source window", async () => {
    unregister = registerEditorKind({ kind: "detach-test", title: () => "test", component: () => null });
    ctrl = new EditorController(createMemoryBackend());
    ctrl.start();
    await ctrl.openInput({ kind: "detach-test", key: "custom", path: "/p/a.bin" }, { focus: false });
    const [pane, id] = current();

    expect(await ctrl.detachTab(pane, id)).toBe(false);
    expect(hasTab(id)).toBe(true);
    expect(prepareEditorWindow).not.toHaveBeenCalled();
  });

  it.each(["C:/project/a.ts", "C:/other/a.ts", "C:/project-other/a.ts"])(
    "keeps the project owner when moving %s",
    async (file) => {
      useProject.setState({
        project: { root: "C:/project", workspace: { projects: ["C:/project", "C:/other"] } } as never,
      });
      ctrl = new EditorController(createMemoryBackend({ [file]: "text\n" }));
      ctrl.start();
      await ctrl.openFile(file, { focus: false });

      expect(await ctrl.detachTab(...current())).toBe(true);
      expect(prepareEditorWindow).toHaveBeenCalledWith(
        expect.objectContaining({
          project: "C:/project",
          tab: expect.objectContaining({ input: expect.objectContaining({ path: file }) }),
        }),
        null,
      );
    },
  );
});
