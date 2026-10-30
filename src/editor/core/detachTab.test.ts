import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorController, useTabs } from "./controller";
import { createMemoryBackend } from "./backend";
import { initialTabsState } from "./model/tabs";
import { useProject } from "@/platform/project";
import { commands } from "@/platform/ipc";
import * as contributions from "@/workbench/contributions";
import { ask } from "@/workbench/messages";
import type * as Messages from "@/workbench/messages";
import { registerEditorKind, type EditorDocumentLifecycle } from "@/workbench/contributions";

vi.mock("@/workbench/messages", async (original) => ({
  ...(await original<typeof Messages>()),
  ask: vi.fn(),
}));

const notify = vi.fn();
let ctrl: EditorController;
let unregister: (() => void) | undefined;
const path = "/p/a.ts";
const current = () => {
  const s = useTabs.getState();
  return [s.activePane, s.panes[s.activePane]!.active!] as const;
};
const hasTab = (id: string) => Object.values(useTabs.getState().panes).some((p) => p.tabs.some((t) => t.id === id));

beforeEach(() => {
  notify.mockReset();
  vi.spyOn(contributions, "notifications").mockReturnValue({ notify });
  useTabs.setState(initialTabsState(), true);
  useProject.setState({ project: null, settings: { files: { autoSave: false } } as never });
  vi.spyOn(commands, "windowOpenFileInNewWindow").mockResolvedValue({
    status: "ok",
    data: { kind: "opened", label: "second" },
  });
});
afterEach(() => {
  ctrl?.stop();
  unregister?.();
  unregister = undefined;
  vi.restoreAllMocks();
  vi.mocked(ask).mockReset();
  useProject.setState({ project: null, settings: null });
});

describe("detachTab", () => {
  it.each([false, true])("waits for text save before opening and closing, autosave=%s", async (autoSave) => {
    useProject.setState({ settings: { files: { autoSave } } as never });
    const backend = createMemoryBackend({ [path]: "original\n" });
    ctrl = new EditorController(backend);
    ctrl.start();
    await ctrl.openFile(path, { focus: false });
    const [pane, id] = current();
    ctrl.slotFor(id)!.dispatchLocal({ changes: { from: 0, to: 8, insert: "edited" } });
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const originalSave = backend.save;
    const save = vi.spyOn(backend, "save").mockImplementation(async (doc) => {
      await gate;
      await originalSave(doc);
    });
    vi.mocked(commands.windowOpenFileInNewWindow).mockImplementation(async () => {
      expect(hasTab(id)).toBe(true);
      expect((await backend.snapshot(ctrl.slotFor(id)!.model.doc)).text).toBe("edited\n");
      return { status: "ok", data: { kind: "opened", label: "second" } };
    });
    const result = ctrl.detachTab(pane, id);
    await vi.waitFor(() => expect(save).toHaveBeenCalled());
    expect(commands.windowOpenFileInNewWindow).not.toHaveBeenCalled();
    expect(hasTab(id)).toBe(true);
    finish();
    expect(await result).toBe(true);
    expect(hasTab(id)).toBe(false);
    expect(ask).not.toHaveBeenCalled();
  });

  it("keeps the tab and opens no window when text saving fails", async () => {
    const backend = createMemoryBackend({ [path]: "original\n" });
    ctrl = new EditorController(backend);
    ctrl.start();
    await ctrl.openFile(path, { focus: false });
    const [pane, id] = current();
    vi.spyOn(backend, "save").mockRejectedValue(new Error("save failed"));
    expect(await ctrl.detachTab(pane, id)).toBe(false);
    expect(hasTab(id)).toBe(true);
    expect(commands.windowOpenFileInNewWindow).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ level: "error", body: "save failed" }));
  });

  it("keeps a pinned text tab if window creation fails", async () => {
    ctrl = new EditorController(createMemoryBackend({ [path]: "original\n" }));
    ctrl.start();
    await ctrl.openFile(path, { focus: false });
    const [pane, id] = current();
    ctrl.togglePin(pane, id);
    vi.mocked(commands.windowOpenFileInNewWindow).mockRejectedValue(new Error("window failed"));
    expect(await ctrl.detachTab(pane, id)).toBe(false);
    expect(useTabs.getState().panes[pane]!.tabs.find((t) => t.id === id)?.pinned).toBe(true);
  });

  it.each(["save", "discard", "cancel", "save failure", "window failure"])(
    "runs the custom document guard once: %s",
    async (decision) => {
      const events: string[] = [];
      const lifecycle: EditorDocumentLifecycle = {
        isDirty: () => true,
        flush: async () => {},
        prepareClose: async () => {
          events.push("prepare");
        },
        cancelClose: () => {
          events.push("cancelClose");
        },
        save: async () => {
          events.push("save");
          if (decision === "save failure") throw new Error("save failed");
        },
        discard: async () => {
          events.push("discard");
        },
        close: async () => {
          events.push("close");
        },
      };
      unregister = registerEditorKind({
        kind: "detach-test",
        title: () => "test",
        component: () => null,
        document: lifecycle,
      });
      ctrl = new EditorController(createMemoryBackend());
      ctrl.start();
      await ctrl.openInput({ kind: "detach-test", key: "custom", path: "/p/a.ipynb" }, { focus: false });
      const [pane, id] = current();
      vi.mocked(ask).mockImplementation(async () => {
        events.push("ask");
        expect(commands.windowOpenFileInNewWindow).not.toHaveBeenCalled();
        return {
          button: decision === "save failure" || decision === "window failure" ? "save" : decision,
          checked: false,
        };
      });
      vi.mocked(commands.windowOpenFileInNewWindow).mockImplementation(async () => {
        events.push("open");
        expect(hasTab(id)).toBe(true);
        if (decision === "window failure") throw new Error("window failed");
        return { status: "ok", data: { kind: "opened", label: "second" } };
      });
      const success = decision === "save" || decision === "discard";
      expect(await ctrl.detachTab(pane, id)).toBe(success);
      expect(hasTab(id)).toBe(!success);
      expect(ask).toHaveBeenCalledOnce();
      expect(events).toEqual(
        success
          ? ["prepare", "ask", decision, "open", "close"]
          : decision === "cancel"
            ? ["prepare", "ask", "cancelClose"]
            : decision === "save failure"
              ? ["prepare", "ask", "save", "cancelClose"]
              : ["prepare", "ask", "save", "open", "cancelClose"],
      );
    },
  );

  it.each([
    ["C:\\project\\a.ts", ["C:/project"], "C:/project"],
    ["C:\\other\\a.ts", ["C:/project", "C:/other"], "C:/project"],
    ["C:\\project-other\\a.ts", ["C:/project"], null],
  ])("routes %s by workspace containment", async (file, projects, expected) => {
    useProject.setState({ project: { root: "C:/project", workspace: { projects } } as never });
    ctrl = new EditorController(createMemoryBackend({ [file]: "text\n" }));
    ctrl.start();
    await ctrl.openFile(file, { focus: false });
    expect(await ctrl.detachTab(...current())).toBe(true);
    expect(commands.windowOpenFileInNewWindow).toHaveBeenCalledWith(expected, file);
  });
});
