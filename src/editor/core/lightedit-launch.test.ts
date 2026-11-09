import { afterEach, describe, expect, it } from "vitest";
import { EditorController, LIGHT_EDIT_SESSION, openFilePaths, useTabs } from "./controller";
import { createMemoryBackend } from "./backend";
import { initialTabsState, openTab, paneIds, togglePin } from "./model/tabs";
import { restoreTabsState, storeSession, type EditorSession } from "./model/session";
import { useProject } from "@/platform/project";

let ctrl: EditorController | null = null;
const initialSettings = useProject.getState().settings;

afterEach(() => {
  ctrl?.stop();
  ctrl = null;
  useTabs.setState(initialTabsState(), true);
  useProject.setState({ project: null, lightEdit: false, settings: initialSettings } as never);
  try {
    localStorage.removeItem(`openidea.editorSession.v1:${LIGHT_EDIT_SESSION}`);
    storeSession("/p", null);
  } catch {
    /* ignore */
  }
});

function activePath() {
  const state = useTabs.getState();
  const pane = state.panes[state.activePane]!;
  return pane.tabs.find((tab) => tab.id === pane.active)?.input.path;
}

function seedLightEditSession() {
  storeSession(LIGHT_EDIT_SESSION, {
    version: 1,
    layout: { kind: "pane", tabs: [{ path: "/p/a.ts" }], active: 0 },
    activePane: 0,
    files: {},
  });
}

describe("lightedit launch (#2229)", () => {
  it("admits the launched file after the saved session restores", async () => {
    seedLightEditSession();
    ctrl = new EditorController(createMemoryBackend({ "/p/a.ts": "a", "/p/b.ts": "b" }));
    ctrl.start();
    // openFilesHere: window has neither project nor LightEdit -> openLightEdit(b) then openInEditor([b]).
    useProject.setState({ project: null, lightEdit: true });
    await ctrl.openFile("/p/b.ts", { focus: true });
    await new Promise((r) => setTimeout(r, 50));
    expect(openFilePaths(useTabs.getState()).sort()).toEqual(["/p/a.ts", "/p/b.ts"]);
    expect(activePath()).toBe("/p/b.ts");
  });

  it("merges a late saved-session restore with the launched tab instead of replacing it", async () => {
    seedLightEditSession();
    ctrl = new EditorController(createMemoryBackend({ "/p/a.ts": "a", "/p/b.ts": "b" }));
    ctrl.start();
    useProject.setState({ project: null, lightEdit: true });
    await ctrl.openFile("/p/b.ts", { focus: true });
    // A stale/second transition restore landing after the admit (#2229).
    await ctrl.restoreSession(LIGHT_EDIT_SESSION);
    await new Promise((r) => setTimeout(r, 50));
    expect(openFilePaths(useTabs.getState()).sort()).toEqual(["/p/a.ts", "/p/b.ts"]);
    expect(activePath()).toBe("/p/b.ts");
  });
});

function savedSplit(dir: "row" | "column" = "row"): EditorSession {
  return {
    version: 1,
    layout: {
      kind: "split",
      dir,
      children: [
        {
          kind: "pane",
          tabs: [
            { path: "/p/a.ts", pinned: true },
            { path: "/p/shared.ts", preview: true },
          ],
          active: 1,
        },
        { kind: "pane", tabs: [{ path: "/p/c.ts", preview: true }, { path: "/p/shared.ts" }], active: 1 },
      ],
    },
    activePane: 1,
    files: {},
  };
}

function setupRestore() {
  ctrl = new EditorController(
    createMemoryBackend({
      "/p/a.ts": "a",
      "/p/b.ts": "b\nsecond",
      "/p/c.ts": "c",
      "/p/shared.ts": "shared",
    }),
  );
  ctrl.start();
  return ctrl;
}

describe.each([LIGHT_EDIT_SESSION, "/p"])("late session restore: %s", (root) => {
  it.each(["row", "column"] as const)(
    "keeps the saved %s split and intentional copies, with the CLI file active in the saved active pane",
    async (dir) => {
      const controller = setupRestore();
      await controller.openFile("/p/b.ts", { selection: { line: 1, col: 2 } });
      const live = controller.activeSlot!;
      storeSession(root, savedSplit(dir));
      await controller.restoreSession(root);
      const state = useTabs.getState();
      expect(state.layout).toMatchObject({ kind: "split", dir });
      expect(paneIds(state)).toHaveLength(2);
      expect(state.activePane).toBe(paneIds(state)[1]);
      expect(
        Object.values(state.panes)
          .flatMap((p) => p.tabs)
          .filter((t) => t.input.path === "/p/shared.ts"),
      ).toHaveLength(2);
      expect(activePath()).toBe("/p/b.ts");
      expect(controller.activeSlot).toBe(live);
      expect(live.caret()).toMatchObject({ line: 1, col: 2 });
      expect(live.wantsFocus).toBe(true);
    },
  );

  it("keeps pins before regular tabs, including after a subsequent pin and open", async () => {
    const controller = setupRestore();
    await controller.openFile("/p/b.ts", { focus: false });
    storeSession(root, {
      version: 1,
      layout: { kind: "pane", tabs: [{ path: "/p/a.ts", pinned: true }], active: 0 },
      activePane: 0,
      files: {},
    });
    await controller.restoreSession(root);
    let state = useTabs.getState();
    expect(state.panes[state.activePane]!.tabs.map((t) => t.pinned)).toEqual([true, false]);
    const pinned = togglePin(state, state.activePane, state.panes[state.activePane]!.active!);
    state = openTab(pinned, pinned.activePane, { kind: "file", key: "file:/p/c.ts", path: "/p/c.ts" }).state;
    expect(state.panes[state.activePane]!.tabs.map((t) => t.pinned)).toEqual([true, true, false]);
  });

  it("keeps at most one preview per pane when the live tab and both saved panes have previews", async () => {
    const controller = setupRestore();
    await controller.openFile("/p/b.ts", { preview: true, focus: false });
    storeSession(root, savedSplit());
    await controller.restoreSession(root);
    for (const pane of Object.values(useTabs.getState().panes))
      expect(pane.tabs.filter((t) => t.preview).length).toBeLessThanOrEqual(1);
    expect(openFilePaths(useTabs.getState())).toContain("/p/b.ts");
  });

  it("enforces the tab limit without evicting the launched tab", async () => {
    useProject.setState({ settings: { editor: { tabs: { tabLimit: 1, closingPolicy: "lru" } } } as never });
    const controller = setupRestore();
    await controller.openFile("/p/b.ts", { focus: false });
    storeSession(root, {
      version: 1,
      layout: { kind: "pane", tabs: [{ path: "/p/a.ts" }], active: 0 },
      activePane: 0,
      files: {},
    });
    await controller.restoreSession(root);
    expect(openFilePaths(useTabs.getState())).toEqual(["/p/b.ts"]);
    expect(activePath()).toBe("/p/b.ts");
  });

  it("keeps the live same-key slot and launch target instead of the saved caret", async () => {
    const controller = setupRestore();
    await controller.openFile("/p/b.ts", { selection: { line: 1, col: 2 } });
    const slot = controller.activeSlot!;
    storeSession(root, {
      version: 1,
      layout: { kind: "pane", tabs: [{ path: "/p/b.ts", pinned: true }], active: 0 },
      activePane: 0,
      files: { "/p/b.ts": { anchor: 0, head: 0 } },
    });
    await controller.restoreSession(root);
    expect(openFilePaths(useTabs.getState())).toEqual(["/p/b.ts"]);
    expect(controller.activeSlot).toBe(slot);
    expect(slot.caret()).toMatchObject({ line: 1, col: 2 });
    expect(useTabs.getState().panes[useTabs.getState().activePane]!.tabs[0]!.pinned).toBe(true);
  });

  it("moves a saved same-key launch target into the saved active pane without losing the split", async () => {
    const controller = setupRestore();
    await controller.openFile("/p/b.ts", { selection: { line: 1, col: 2 } });
    const slot = controller.activeSlot!;
    const session = savedSplit();
    if (session.layout.kind !== "split") throw new Error("expected split");
    session.layout.children[0] = { kind: "pane", tabs: [{ path: "/p/b.ts", pinned: true }], active: 0 };
    storeSession(root, session);
    await controller.restoreSession(root);
    const state = useTabs.getState();
    expect(state.layout).toMatchObject({ kind: "split", dir: "row" });
    expect(state.activePane).toBe(paneIds(state)[1]);
    expect(
      Object.values(state.panes)
        .flatMap((p) => p.tabs)
        .filter((t) => t.input.path === "/p/b.ts"),
    ).toHaveLength(1);
    expect(controller.activeSlot).toBe(slot);
    expect(slot.caret()).toMatchObject({ line: 1, col: 2 });
    expect(state.panes[state.activePane]!.tabs[0]!.pinned).toBe(true);
  });

  it("protects every live tab when they already exceed the configured limit", async () => {
    const controller = setupRestore();
    await controller.openFile("/p/b.ts", { focus: false });
    await controller.openFile("/p/c.ts", { preview: true, focus: false });
    useProject.setState({ settings: { editor: { tabs: { tabLimit: 1 } } } as never });
    storeSession(root, {
      version: 1,
      layout: { kind: "pane", tabs: [{ path: "/p/a.ts" }], active: 0 },
      activePane: 0,
      files: {},
    });
    await controller.restoreSession(root);
    expect(openFilePaths(useTabs.getState()).sort()).toEqual(["/p/b.ts", "/p/c.ts"]);
    expect(activePath()).toBe("/p/c.ts");
  });

  it("takes the saved state unchanged when the window is empty", async () => {
    const controller = setupRestore();
    storeSession(root, savedSplit());
    await controller.restoreSession(root);
    const saved = restoreTabsState(savedSplit(), (p) => `file:${p}`);
    const state = useTabs.getState();
    expect(paneIds(state)).toHaveLength(2);
    expect(Object.values(state.panes).map((p) => p.tabs.map((t) => [t.input.path, t.pinned, t.preview]))).toEqual(
      Object.values(saved.panes).map((p) => p.tabs.map((t) => [t.input.path, t.pinned, t.preview])),
    );
    expect(activePath()).toBe("/p/shared.ts");
  });
});
