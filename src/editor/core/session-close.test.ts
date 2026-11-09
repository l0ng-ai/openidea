import { afterEach, describe, expect, it } from "vitest";
import { useProject } from "@/platform/project";
import { EditorController, LIGHT_EDIT_SESSION, openFilePaths, useTabs } from "./controller";
import { createMemoryBackend } from "./backend";
import { initialTabsState } from "./model/tabs";
import { loadSession, storeSession } from "./model/session";

let ctrl: EditorController | null = null;
const initialSettings = useProject.getState().settings;
const PROJECT = "/proj";

afterEach(() => {
  ctrl?.stop();
  ctrl = null;
  useTabs.setState(initialTabsState(), true);
  useProject.setState({ project: null, lightEdit: false, settings: initialSettings } as never);
  for (const key of [LIGHT_EDIT_SESSION, PROJECT]) {
    try {
      localStorage.removeItem(`openidea.editorSession.v1:${key}`);
    } catch {
      /* ignore */
    }
  }
});

function paths() {
  return openFilePaths(useTabs.getState());
}

const flush = () => new Promise((r) => setTimeout(r, 50));

function seed(root: string, path: string) {
  storeSession(root, {
    version: 1,
    layout: { kind: "pane", tabs: [{ path }], active: 0 },
    activePane: 0,
    files: {},
  });
}

describe("editor tabs after the window closes", () => {
  it("does not restore tabs a close dropped, and a later save does not put them back", async () => {
    seed(LIGHT_EDIT_SESSION, "/p/a.ts");
    ctrl = new EditorController(createMemoryBackend({ "/p/a.ts": "a", "/p/b.ts": "b", "/p/c.ts": "c" }));
    ctrl.start();
    useProject.setState({ project: null, lightEdit: true });
    await ctrl.openFile("/p/b.ts", { focus: true });
    await flush();
    expect(paths().sort()).toEqual(["/p/a.ts", "/p/b.ts"]);

    ctrl.forgetSavedTabs();
    expect(loadSession(LIGHT_EDIT_SESSION)).toBeNull();
    window.dispatchEvent(new Event("pagehide"));
    ctrl.saveSession();
    expect(loadSession(LIGHT_EDIT_SESSION)).toBeNull();

    useProject.setState({ project: null, lightEdit: false });
    await flush();
    useProject.setState({ project: null, lightEdit: true });
    await ctrl.openFile("/p/c.ts", { focus: true });
    await flush();
    expect(paths()).toEqual(["/p/c.ts"]);
    ctrl.saveSession();
    const saved = JSON.stringify(loadSession(LIGHT_EDIT_SESSION));
    expect(saved).toContain("/p/c.ts");
    expect(saved).not.toContain("/p/a.ts");
  });

  it("writes the open tabs again when the close is cancelled", async () => {
    seed(LIGHT_EDIT_SESSION, "/p/a.ts");
    ctrl = new EditorController(createMemoryBackend({ "/p/a.ts": "a", "/p/b.ts": "b" }));
    ctrl.start();
    useProject.setState({ project: null, lightEdit: true });
    await ctrl.openFile("/p/b.ts", { focus: true });
    await flush();
    ctrl.forgetSavedTabs();
    expect(loadSession(LIGHT_EDIT_SESSION)).toBeNull();
    ctrl.keepSavedTabs();
    expect(JSON.stringify(loadSession(LIGHT_EDIT_SESSION))).toContain("/p/b.ts");
  });

  it("drops only the closed window's session", async () => {
    seed(LIGHT_EDIT_SESSION, "/p/a.ts");
    seed(PROJECT, "/proj/main.ts");
    ctrl = new EditorController(createMemoryBackend({ "/p/a.ts": "a", "/proj/main.ts": "main" }));
    ctrl.start();
    useProject.setState({ project: null, lightEdit: true });
    await flush();
    ctrl.forgetSavedTabs();
    useProject.setState({ project: null, lightEdit: false });
    await flush();
    expect(loadSession(LIGHT_EDIT_SESSION)).toBeNull();
    expect(loadSession(PROJECT)?.layout).toMatchObject({ kind: "pane", tabs: [{ path: "/proj/main.ts" }] });

    useProject.setState({ project: { root: PROJECT, name: "proj" }, lightEdit: false } as never);
    await flush();
    expect(paths()).toEqual(["/proj/main.ts"]);
  });
});
