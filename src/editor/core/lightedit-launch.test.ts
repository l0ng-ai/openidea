import { afterEach, describe, expect, it } from "vitest";
import { EditorController, LIGHT_EDIT_SESSION, openFilePaths, useTabs } from "./controller";
import { createMemoryBackend } from "./backend";
import { initialTabsState } from "./model/tabs";
import { storeSession } from "./model/session";
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
    ctrl.restoreSession(LIGHT_EDIT_SESSION);
    await new Promise((r) => setTimeout(r, 50));
    expect(openFilePaths(useTabs.getState()).sort()).toEqual(["/p/a.ts", "/p/b.ts"]);
    expect(activePath()).toBe("/p/b.ts");
  });
});
