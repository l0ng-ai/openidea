import { afterEach, describe, expect, it, vi } from "vitest";
import { registerFileEditorProvider } from "@/workbench/contributions";
import { EditorController, openFilePaths, useTabs } from "./controller";
import { createMemoryBackend } from "./backend";
import { initialTabsState } from "./model/tabs";
import { useProject } from "@/platform/project";

let ctrl: EditorController | null = null;
let dispose: (() => void) | undefined;
const initialSettings = useProject.getState().settings;

afterEach(() => {
  dispose?.();
  dispose = undefined;
  ctrl?.stop();
  ctrl = null;
  useTabs.setState(initialTabsState(), true);
  useProject.setState({ settings: initialSettings });
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function activePath() {
  const state = useTabs.getState();
  const pane = state.panes[state.activePane]!;
  return pane.tabs.find((tab) => tab.id === pane.active)?.input.path;
}

function setup() {
  ctrl = new EditorController(createMemoryBackend({ "/p/a.ts": "a\nsecond", "/p/b.ts": "b", "/p/c.ts": "c" }));
  ctrl.start();
  return ctrl;
}

function delayProvider(path = "/p/a.ts") {
  const started = deferred();
  const response = deferred();
  let delayed = false;
  dispose = registerFileEditorProvider({
    id: "delayed-file",
    resolve: async (requested) => {
      if (requested === path && !delayed) {
        delayed = true;
        started.resolve();
        await response.promise;
      }
      return null;
    },
  });
  return { started, response };
}

function tabFor(path: string) {
  return Object.values(useTabs.getState().panes)
    .flatMap((pane) => pane.tabs)
    .find((tab) => tab.input.path === path);
}

describe("file open order", () => {
  it.each([1, 30])("keeps the newer file active after an earlier probe (tab limit: %s)", async (tabLimit) => {
    useProject.setState({ settings: { editor: { tabs: { tabLimit } } } as never });
    const { started, response } = delayProvider();
    const controller = setup();
    const first = controller.openFile("/p/a.ts", { focus: false });
    await started.promise;
    await controller.openFile("/p/b.ts", { focus: false });
    expect(activePath()).toBe("/p/b.ts");
    response.resolve();
    await first;
    expect(openFilePaths(useTabs.getState()).sort()).toEqual(tabLimit === 1 ? ["/p/b.ts"] : ["/p/a.ts", "/p/b.ts"]);
    expect(activePath()).toBe("/p/b.ts");
    expect(controller.activeSlot?.model.path).toBe("/p/b.ts");
  });

  it("activates the newer file after an earlier probe finishes while both are pending", async () => {
    const a = { started: deferred(), response: deferred() };
    const b = { started: deferred(), response: deferred() };
    dispose = registerFileEditorProvider({
      id: "two-delayed-files",
      resolve: async (path) => {
        const pending = path === "/p/a.ts" ? a : b;
        pending.started.resolve();
        await pending.response.promise;
        return null;
      },
    });
    const controller = setup();
    const first = controller.openFile("/p/a.ts", { focus: false });
    await a.started.promise;
    const second = controller.openFile("/p/b.ts", { focus: false });
    await b.started.promise;
    a.response.resolve();
    await first;
    b.response.resolve();
    await second;
    expect(openFilePaths(useTabs.getState()).sort()).toEqual(["/p/a.ts", "/p/b.ts"]);
    expect(activePath()).toBe("/p/b.ts");
  });

  it("discards an earlier preview without replacing the newer preview", async () => {
    const { started, response } = delayProvider();
    const controller = setup();
    const first = controller.openFile("/p/a.ts", { preview: true, focus: false });
    await started.promise;
    await controller.openFile("/p/b.ts", { preview: true, focus: false });
    response.resolve();
    await first;
    expect(openFilePaths(useTabs.getState())).toEqual(["/p/b.ts"]);
    expect(tabFor("/p/b.ts")?.preview).toBe(true);
    expect(activePath()).toBe("/p/b.ts");
  });

  it("keeps an earlier regular file without removing the newer preview", async () => {
    const { started, response } = delayProvider();
    const controller = setup();
    const first = controller.openFile("/p/a.ts", { focus: false });
    await started.promise;
    await controller.openFile("/p/b.ts", { preview: true, focus: false });
    response.resolve();
    await first;
    expect(openFilePaths(useTabs.getState()).sort()).toEqual(["/p/a.ts", "/p/b.ts"]);
    expect(tabFor("/p/a.ts")?.preview).toBe(false);
    expect(tabFor("/p/b.ts")?.preview).toBe(true);
    expect(activePath()).toBe("/p/b.ts");
  });

  it("keeps manual tab activation while an earlier probe is pending", async () => {
    const { started, response } = delayProvider();
    const controller = setup();
    await controller.openFile("/p/b.ts", { focus: false });
    await controller.openFile("/p/c.ts", { focus: false });
    const first = controller.openFile("/p/a.ts", { focus: false });
    await started.promise;
    controller.activate(useTabs.getState().activePane, tabFor("/p/b.ts")!.id, false);
    response.resolve();
    await first;
    expect(openFilePaths(useTabs.getState()).sort()).toEqual(["/p/a.ts", "/p/b.ts", "/p/c.ts"]);
    expect(activePath()).toBe("/p/b.ts");
  });

  it("keeps a newer explicit open regular when the same file's preview resolves late", async () => {
    const { started, response } = delayProvider();
    const controller = setup();
    const preview = controller.openFile("/p/a.ts", { preview: true, focus: false });
    await started.promise;
    await controller.openFile("/p/a.ts", { focus: false });
    response.resolve();
    await preview;
    expect(openFilePaths(useTabs.getState())).toEqual(["/p/a.ts"]);
    expect(tabFor("/p/a.ts")?.preview).toBe(false);
    expect(activePath()).toBe("/p/a.ts");
  });

  it("promotes an admitted preview when the same file is opened explicitly", async () => {
    const controller = setup();
    await controller.openFile("/p/a.ts", { preview: true, focus: false });
    const tabId = tabFor("/p/a.ts")!.id;
    expect(tabFor("/p/a.ts")?.preview).toBe(true);
    await controller.openFile("/p/a.ts", { focus: false });
    expect(openFilePaths(useTabs.getState())).toEqual(["/p/a.ts"]);
    expect(tabFor("/p/a.ts")).toMatchObject({ id: tabId, preview: false });
    expect(activePath()).toBe("/p/a.ts");
  });

  it("keeps the newer selection when an earlier open of the same file resolves late", async () => {
    const { started, response } = delayProvider();
    const controller = setup();
    const first = controller.openFile("/p/a.ts", { selection: { line: 0, col: 0 }, focus: false });
    await started.promise;
    await controller.openFile("/p/a.ts", { selection: { line: 1, col: 0 }, focus: false });
    response.resolve();
    await first;
    const state = controller.slotFor(tabFor("/p/a.ts")!.id)!.currentState();
    expect(state.doc.lineAt(state.selection.main.head).number).toBe(2);
  });

  it.each([true, false])("keeps a delayed open in its origin pane (explicit: %s)", async (explicit) => {
    const { started, response } = delayProvider();
    const controller = setup();
    await controller.openFile("/p/b.ts", { focus: false });
    const origin = useTabs.getState().activePane;
    controller.split(origin, "row");
    const other = useTabs.getState().activePane;
    expect(other).not.toBe(origin);
    controller.activate(origin, tabFor("/p/b.ts")!.id, false);
    const first = controller.openFile("/p/a.ts", { ...(explicit ? { pane: origin } : {}), focus: false });
    await started.promise;
    await controller.openFile("/p/c.ts", { pane: other, focus: false });
    response.resolve();
    await first;
    const state = useTabs.getState();
    expect(state.panes[origin]!.tabs.some((tab) => tab.input.path === "/p/a.ts")).toBe(true);
    expect(state.panes[other]!.tabs.some((tab) => tab.input.path === "/p/a.ts")).toBe(false);
    expect(activePath()).toBe("/p/c.ts");
  });

  it("does not request focus when an earlier document finishes loading late", async () => {
    const backend = createMemoryBackend({ "/p/a.ts": "a", "/p/b.ts": "b" });
    const started = deferred();
    const response = deferred();
    const open = backend.open.bind(backend);
    backend.open = async (path) => {
      if (path === "/p/a.ts") {
        started.resolve();
        await response.promise;
      }
      return open(path);
    };
    ctrl = new EditorController(backend);
    ctrl.start();
    const first = ctrl.openFile("/p/a.ts");
    await started.promise;
    await ctrl.openFile("/p/b.ts", { focus: false });
    response.resolve();
    await first;
    expect(openFilePaths(useTabs.getState()).sort()).toEqual(["/p/a.ts", "/p/b.ts"]);
    expect(activePath()).toBe("/p/b.ts");
    expect(ctrl.slotFor(tabFor("/p/a.ts")!.id)?.wantsFocus).toBe(false);
  });

  it("does not run queued mount focus after a newer file becomes active", async () => {
    const controller = setup();
    await controller.openFile("/p/a.ts");
    const slot = controller.slotFor(tabFor("/p/a.ts")!.id)!;
    expect(slot.wantsFocus).toBe(true);
    const focus = vi.spyOn(slot, "focus");
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => frames.push(callback));
    try {
      controller.onMounted(slot);
      expect(frames.length).toBeGreaterThan(0);
      await controller.openFile("/p/b.ts", { focus: false });
      for (const frame of frames) frame(0);
      expect(focus).not.toHaveBeenCalled();
      expect(activePath()).toBe("/p/b.ts");
    } finally {
      vi.unstubAllGlobals();
      focus.mockRestore();
    }
  });

  it("rolls back a superseded custom preview before provider admission", async () => {
    const started = deferred();
    const response = deferred();
    const commit = vi.fn();
    const rollback = vi.fn(async () => {});
    dispose = registerFileEditorProvider({
      id: "delayed-custom-preview",
      resolve: async (path, context) => {
        if (path !== "/p/a.ts") return null;
        context.onAdmission(commit, rollback);
        started.resolve();
        await response.promise;
        return { kind: "image", key: "image:/p/a.ts", path };
      },
    });
    const controller = setup();
    const first = controller.openFile("/p/a.ts", { preview: true, focus: false });
    await started.promise;
    await controller.openFile("/p/b.ts", { preview: true, focus: false });
    response.resolve();
    await first;
    expect(commit).not.toHaveBeenCalled();
    expect(rollback).toHaveBeenCalledOnce();
    expect(activePath()).toBe("/p/b.ts");
    expect(tabFor("/p/a.ts")).toBeUndefined();
  });
});
