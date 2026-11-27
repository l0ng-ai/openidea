import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { executeAction, getAction } from "@/platform/actions";
import { resolveActionId } from "@/features/vim/rc";
import { registerEditorActions } from "./actions";
import { editorController, useTabs } from "./controller";
import { initialTabsState, paneIds } from "./model/tabs";

const ctrl = editorController();
let dispose: () => void;
beforeAll(() => {
  dispose = registerEditorActions();
  ctrl.start();
});
afterAll(() => {
  ctrl.stop();
  dispose();
});
afterEach(async () => {
  await ctrl.closeEverything();
  useTabs.setState(initialTabsState(), true);
});

const names = (paneId: string) => useTabs.getState().panes[paneId]!.tabs.map((t) => t.input.path);
const open = async (...paths: string[]) => {
  // oxlint-disable-next-line no-await-in-loop -- the tab order is what these tests assert
  for (const p of paths) await ctrl.openFile(p, { focus: false });
};

describe("Window › Editor Tabs › Split and Move", () => {
  it.each([
    ["editor.splitAndMoveRight", "Split and Move Right", "MoveTabRight"],
    ["editor.splitAndMoveDown", "Split and Move Down", "MoveTabDown"],
  ])("%s is %s in Window, mapped from IDEA's %s", (id, title, ideaId) => {
    expect(getAction(id)).toMatchObject({ title, category: "Window" });
    expect(resolveActionId(ideaId)).toBe(id);
  });

  it.each([
    ["editor.splitAndMoveRight", "row"],
    ["editor.splitAndMoveDown", "column"],
  ])("%s moves the active tab into a new split and focuses it", async (id, dir) => {
    await open("/a", "/b", "/c");
    const first = useTabs.getState().activePane;
    ctrl.activate(first, useTabs.getState().panes[first]!.tabs[1]!.id, false);
    expect(await executeAction(id)).toBe(true);
    const s = useTabs.getState();
    expect(s.layout).toMatchObject({ kind: "split", dir });
    const [left, right] = paneIds(s);
    expect(left).toBe(first);
    expect(names(left!)).toEqual(["/a", "/c"]);
    expect(names(right!)).toEqual(["/b"]);
    expect(s.activePane).toBe(right);
  });

  it("acts on the active group of an existing split", async () => {
    await open("/a", "/b");
    const first = useTabs.getState().activePane;
    expect(await executeAction("editor.splitAndMoveRight")).toBe(true);
    const second = useTabs.getState().activePane;
    await ctrl.openFile("/c", { focus: false });
    expect(names(second)).toEqual(["/b", "/c"]);
    expect(await executeAction("editor.splitAndMoveDown")).toBe(true);
    const s = useTabs.getState();
    expect(paneIds(s)).toHaveLength(3);
    expect(names(first)).toEqual(["/a"]);
    expect(names(second)).toEqual(["/b"]);
    expect(names(s.activePane)).toEqual(["/c"]);
  });

  it("is unavailable when the group has a single tab, as moving it would only replace the group", async () => {
    await open("/a");
    const before = useTabs.getState();
    expect(await executeAction("editor.splitAndMoveRight")).toBe(false);
    expect(await executeAction("editor.splitAndMoveDown")).toBe(false);
    expect(useTabs.getState().layout).toEqual(before.layout);
  });

  it("is unavailable without open tabs", async () => {
    expect(await executeAction("editor.splitAndMoveRight")).toBe(false);
  });
});
